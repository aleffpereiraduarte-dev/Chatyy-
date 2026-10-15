import AVFoundation
import UIKit

// [2026-10-15 native-attach] Sessão de câmera ÚNICA do app para a folha de
// anexos (tile ao vivo) e a câmera do chat. Pré-configurada (entradas +
// saídas) em prewarm(); acquire()/relinquish() fazem refcount do
// startRunning, com atraso de 1.5 s no stop → tile da folha → câmera cheia
// troca de dono sem parar a sessão (abre "quente", < 300 ms).
//
// Áudio só entra na sessão enquanto a câmera cheia está aberta (o tile da
// folha não acende o indicador laranja do microfone).
final class CAEngine: NSObject {
  static let shared = CAEngine()

  let session = AVCaptureSession()
  let queue = DispatchQueue(label: "br.com.chatyy.attach.camera", qos: .userInitiated)
  let photoOutput = AVCapturePhotoOutput()
  let movieOutput = AVCaptureMovieFileOutput()

  private(set) var position: AVCaptureDevice.Position = .back
  private(set) var videoInput: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private var configured = false
  private var users = 0
  private var stopToken = 0

  static var authorized: Bool {
    return AVCaptureDevice.authorizationStatus(for: .video) == .authorized
  }

  var device: AVCaptureDevice? { return videoInput?.device }

  // MARK: configuração

  func prewarm() {
    guard CAEngine.authorized else { return }
    queue.async { self.configureIfNeeded() }
  }

  /// Sem usuários ativos: desmonta a configuração (libera o hardware).
  func teardownIfIdle() {
    queue.async {
      guard self.users == 0, self.configured else { return }
      if self.session.isRunning { self.session.stopRunning() }
      self.session.beginConfiguration()
      for i in self.session.inputs { self.session.removeInput(i) }
      for o in self.session.outputs { self.session.removeOutput(o) }
      self.session.commitConfiguration()
      self.videoInput = nil
      self.audioInput = nil
      self.configured = false
    }
  }

  private static func camera(_ pos: AVCaptureDevice.Position) -> AVCaptureDevice? {
    if let d = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: pos) { return d }
    return AVCaptureDevice.default(for: .video)
  }

  /// Chamar SEMPRE na `queue`.
  private func configureIfNeeded() {
    if configured { return }
    guard CAEngine.authorized else { return }
    session.beginConfiguration()
    if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
    if videoInput == nil, let dev = CAEngine.camera(position),
       let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) {
      session.addInput(input)
      videoInput = input
    }
    if !session.outputs.contains(photoOutput), session.canAddOutput(photoOutput) {
      session.addOutput(photoOutput)
    }
    if !session.outputs.contains(movieOutput), session.canAddOutput(movieOutput) {
      session.addOutput(movieOutput)
    }
    session.commitConfiguration()
    configurePhotoOutput()
    applyConnections()
    configured = videoInput != nil
  }

  private func configurePhotoOutput() {
    guard let dev = videoInput?.device else { return }
    if let maxDim = dev.activeFormat.supportedMaxPhotoDimensions.last {
      photoOutput.maxPhotoDimensions = maxDim
    }
    photoOutput.maxPhotoQualityPrioritization = .balanced
  }

  private func applyConnections() {
    let front = position == .front
    for out in [photoOutput as AVCaptureOutput, movieOutput as AVCaptureOutput] {
      guard let c = out.connection(with: .video) else { continue }
      if c.isVideoOrientationSupported { c.videoOrientation = .portrait }
      if c.isVideoMirroringSupported {
        c.automaticallyAdjustsVideoMirroring = false
        c.isVideoMirrored = front
      }
      if out === movieOutput, c.isVideoStabilizationSupported {
        c.preferredVideoStabilizationMode = .auto
      }
    }
  }

  // MARK: execução

  func acquire(_ started: (() -> Void)? = nil) {
    queue.async {
      self.users += 1
      self.stopToken += 1
      self.configureIfNeeded()
      if self.configured && !self.session.isRunning { self.session.startRunning() }
      if let started = started { DispatchQueue.main.async { started() } }
    }
  }

  func relinquish() {
    queue.async {
      self.users = max(0, self.users - 1)
      guard self.users == 0 else { return }
      self.stopToken += 1
      let token = self.stopToken
      self.queue.asyncAfter(deadline: .now() + 1.5) {
        guard self.users == 0, token == self.stopToken else { return }
        if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
        if self.session.isRunning { self.session.stopRunning() }
        self.removeAudioLocked()
      }
    }
  }

  // MARK: áudio (só câmera cheia)

  func addAudio() {
    queue.async {
      guard self.audioInput == nil,
            AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            let mic = AVCaptureDevice.default(for: .audio),
            let input = try? AVCaptureDeviceInput(device: mic) else { return }
      self.session.beginConfiguration()
      if self.session.canAddInput(input) {
        self.session.addInput(input)
        self.audioInput = input
      }
      self.session.commitConfiguration()
    }
  }

  func removeAudio() {
    queue.async { self.removeAudioLocked() }
  }

  private func removeAudioLocked() {
    guard let a = audioInput else { return }
    session.beginConfiguration()
    session.removeInput(a)
    session.commitConfiguration()
    audioInput = nil
  }

  // MARK: controles

  func flip(_ done: @escaping (AVCaptureDevice.Position) -> Void) {
    queue.async {
      let next: AVCaptureDevice.Position = self.position == .back ? .front : .back
      guard let dev = CAEngine.camera(next), let input = try? AVCaptureDeviceInput(device: dev) else {
        DispatchQueue.main.async { done(self.position) }
        return
      }
      self.session.beginConfiguration()
      if let old = self.videoInput { self.session.removeInput(old) }
      if self.session.canAddInput(input) {
        self.session.addInput(input)
        self.videoInput = input
        self.position = next
      } else if let old = self.videoInput, self.session.canAddInput(old) {
        self.session.addInput(old)
      }
      self.session.commitConfiguration()
      self.configurePhotoOutput()
      self.applyConnections()
      let pos = self.position
      DispatchQueue.main.async { done(pos) }
    }
  }

  var maxZoom: CGFloat {
    guard let d = device else { return 1 }
    return max(1, min(d.activeFormat.videoMaxZoomFactor, 10))
  }

  /// Chamável da main thread (lock de configuração é thread-safe).
  func setZoom(_ factor: CGFloat) {
    guard let d = device else { return }
    let z = max(d.minAvailableVideoZoomFactor, min(factor, maxZoom))
    do {
      try d.lockForConfiguration()
      d.videoZoomFactor = z
      d.unlockForConfiguration()
    } catch {}
  }

  var zoom: CGFloat { return device?.videoZoomFactor ?? 1 }

  func focus(at devicePoint: CGPoint) {
    guard let d = device else { return }
    do {
      try d.lockForConfiguration()
      if d.isFocusPointOfInterestSupported && d.isFocusModeSupported(.autoFocus) {
        d.focusPointOfInterest = devicePoint
        d.focusMode = .autoFocus
      }
      if d.isExposurePointOfInterestSupported && d.isExposureModeSupported(.autoExpose) {
        d.exposurePointOfInterest = devicePoint
        d.exposureMode = .autoExpose
      }
      d.isSubjectAreaChangeMonitoringEnabled = true
      d.unlockForConfiguration()
    } catch {}
  }

  func resetFocus() {
    guard let d = device else { return }
    do {
      try d.lockForConfiguration()
      if d.isFocusModeSupported(.continuousAutoFocus) { d.focusMode = .continuousAutoFocus }
      if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
      d.isSubjectAreaChangeMonitoringEnabled = false
      d.unlockForConfiguration()
    } catch {}
  }

  func setTorch(_ on: Bool) {
    guard let d = device, d.hasTorch, d.isTorchAvailable else { return }
    do {
      try d.lockForConfiguration()
      d.torchMode = on ? .on : .off
      d.unlockForConfiguration()
    } catch {}
  }

  var hasFlash: Bool { return device?.hasFlash ?? false }

  /// Orientação física no momento da captura (UI travada em retrato).
  func setCaptureOrientation(_ o: AVCaptureVideoOrientation) {
    for out in [photoOutput as AVCaptureOutput, movieOutput as AVCaptureOutput] {
      if let c = out.connection(with: .video), c.isVideoOrientationSupported { c.videoOrientation = o }
    }
  }

  static func orientationFromDevice() -> AVCaptureVideoOrientation {
    switch UIDevice.current.orientation {
    case .landscapeLeft: return .landscapeRight
    case .landscapeRight: return .landscapeLeft
    case .portraitUpsideDown: return .portraitUpsideDown
    default: return .portrait
    }
  }
}

/// UIView cujo layer É o preview (redimensiona sozinho com a view).
final class CAPreviewView: UIView {
  override class var layerClass: AnyClass { return AVCaptureVideoPreviewLayer.self }
  var previewLayer: AVCaptureVideoPreviewLayer { return layer as! AVCaptureVideoPreviewLayer }

  override init(frame: CGRect) {
    super.init(frame: frame)
    previewLayer.videoGravity = .resizeAspectFill
    backgroundColor = .black
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func attach() {
    if previewLayer.session !== CAEngine.shared.session { previewLayer.session = CAEngine.shared.session }
    if let c = previewLayer.connection, c.isVideoOrientationSupported { c.videoOrientation = .portrait }
  }

  func detach() {
    previewLayer.session = nil
  }
}
