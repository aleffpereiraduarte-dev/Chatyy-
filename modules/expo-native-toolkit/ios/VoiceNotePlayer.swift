import AVFoundation
import UIKit

/// [2026-10-07 voice-native] WhatsApp-grade voice-note player.
///
/// Owned by ExpoNativeAudioModule (functions `voice*`, events `onVoiceStatus`
/// / `onVoiceProximity`). One player for the whole app — the JS singleton
/// (services/voiceNotePlayer.js) decides WHAT plays; this class decides HOW:
///
///   • AVPlayer (local file:// AND remote https — same formats expo-audio
///     played before: m4a/AAC, mp3, wav; old notes keep working).
///   • Status ticks every 250 ms + on every state change. JS interpolates
///     between ticks on the UI thread (Reanimated withTiming), so the bubble
///     never re-renders per tick.
///   • Proximity (raise-to-ear): while playing on the loudspeaker with no
///     headset, UIDevice proximity monitoring is ON — iOS blanks the screen by
///     itself when the phone is at the ear, and we flip the session to
///     .playAndRecord + receiver (earpiece). Lowering the phone pauses (WA).
///   • Never touches the session while a call owns it (mode voiceChat /
///     videoChat — set by expo-audio-session / CallKit AudioRouter, which this
///     file deliberately does not import or call).
///
/// Every method must run on the main queue (module uses `.runOnQueue(.main)`).
final class VoiceNotePlayer: NSObject {
  typealias Emit = (_ name: String, _ body: [String: Any]) -> Void

  private let emit: Emit
  private var player: AVPlayer?
  private var item: AVPlayerItem?
  private var timeObserver: Any?
  private var statusObservation: NSKeyValueObservation?
  private var endObserver: NSObjectProtocol?
  private var proximityObserver: NSObjectProtocol?
  private var routeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?

  private var token: Int = 0
  private var rate: Float = 1
  private var playing = false
  private var proximityWanted = false
  private var earpiece = false
  private var ownsSession = false
  private var lastDurationMs: Double = 0

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
  }

  deinit {
    // Safety net only — the module calls release() in OnDestroy.
    if let obs = timeObserver { player?.removeTimeObserver(obs) }
  }

  // MARK: - Public API (main queue)

  func play(uri: String, startMs: Double, rate newRate: Double, token newToken: Int) throws {
    teardownPlayer()
    guard let url = VoiceNotePlayer.makeURL(uri) else {
      throw NSError(domain: "VoiceNote", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid uri"])
    }
    token = newToken
    rate = Float(max(0.5, min(3.0, newRate)))
    // Auto-advance while the phone is still at the ear → next note stays on
    // the earpiece (WhatsApp). Otherwise start on the loudspeaker.
    let keepEar = earpiece && UIDevice.current.isProximityMonitoringEnabled && UIDevice.current.proximityState
    earpiece = keepEar
    lastDurationMs = 0

    configureSession(earpiece: keepEar)

    let newItem = AVPlayerItem(url: url)
    newItem.audioTimePitchAlgorithm = .spectral
    let newPlayer = AVPlayer(playerItem: newItem)
    newPlayer.automaticallyWaitsToMinimizeStalling = true
    item = newItem
    player = newPlayer

    statusObservation = newItem.observe(\.status, options: [.new]) { [weak self] it, _ in
      DispatchQueue.main.async {
        guard let self = self, it === self.item else { return }
        if it.status == .failed {
          self.playing = false
          self.updateProximity()
          self.emitStatus(extra: ["error": it.error?.localizedDescription ?? "playback_failed"])
        } else if it.status == .readyToPlay {
          self.emitStatus()
        }
      }
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: newItem, queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.playing = false
      // Keep the route as-is (earpiece stays earpiece) so an auto-advanced
      // next note continues at the ear; JS calls voiceStop when the chain ends.
      self.emitStatus(extra: ["ended": true])
      self.updateProximity()
    }
    let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
    timeObserver = newPlayer.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
      guard let self = self, self.playing else { return }
      self.emitStatus()
    }
    observeSessionIfNeeded()

    if startMs > 0 {
      newPlayer.seek(to: CMTime(seconds: startMs / 1000.0, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: .zero)
    }
    startPlayback()
  }

  func pause() {
    pauseInternal(reason: nil)
  }

  func resume() {
    guard let p = player, item != nil else { return }
    // Finished → restart from the top (WhatsApp tap-after-end behaviour).
    if let it = item, it.duration.isNumeric,
       p.currentTime().seconds >= it.duration.seconds - 0.05 {
      p.seek(to: .zero)
    }
    configureSession(earpiece: earpiece)
    startPlayback()
  }

  func seek(ms: Double) {
    guard let p = player else { return }
    let t = CMTime(seconds: max(0, ms) / 1000.0, preferredTimescale: 600)
    p.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      DispatchQueue.main.async { self?.emitStatus(extra: ["seeked": true]) }
    }
  }

  func setRate(_ r: Double) {
    rate = Float(max(0.5, min(3.0, r)))
    guard let p = player else { return }
    if #available(iOS 16.0, *) { p.defaultRate = rate }
    if playing { p.rate = rate }
    emitStatus()
  }

  func stop() {
    teardownPlayer()
    playing = false
    if earpiece { earpiece = false }
    updateProximity()
    releaseSession()
  }

  func setProximityEnabled(_ on: Bool) {
    proximityWanted = on
    updateProximity()
  }

  func status() -> [String: Any] {
    return statusBody()
  }

  func release() {
    stop()
    if let o = routeObserver { NotificationCenter.default.removeObserver(o); routeObserver = nil }
    if let o = interruptionObserver { NotificationCenter.default.removeObserver(o); interruptionObserver = nil }
  }

  // MARK: - Internals

  private func startPlayback() {
    guard let p = player else { return }
    if #available(iOS 16.0, *) { p.defaultRate = rate }
    p.play()
    p.rate = rate
    playing = true
    updateProximity()
    emitStatus()
  }

  private func pauseInternal(reason: String?) {
    player?.pause()
    let was = playing
    playing = false
    if earpiece {
      earpiece = false
      configureSession(earpiece: false)
    }
    updateProximity()
    if was || reason != nil {
      var extra: [String: Any] = [:]
      if let r = reason { extra["reason"] = r }
      emitStatus(extra: extra)
    }
  }

  private func teardownPlayer() {
    if let obs = timeObserver, let p = player { p.removeTimeObserver(obs) }
    timeObserver = nil
    statusObservation?.invalidate()
    statusObservation = nil
    if let o = endObserver { NotificationCenter.default.removeObserver(o) }
    endObserver = nil
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    item = nil
  }

  private func statusBody() -> [String: Any] {
    var pos: Double = 0
    if let p = player {
      let s = p.currentTime().seconds
      if s.isFinite { pos = max(0, s * 1000.0) }
    }
    var dur: Double = lastDurationMs
    if let it = item, it.duration.isNumeric {
      let s = it.duration.seconds
      if s.isFinite && s > 0 { dur = s * 1000.0; lastDurationMs = dur }
    }
    return [
      "token": token,
      "positionMs": pos,
      "durationMs": dur,
      "playing": playing,
      "earpiece": earpiece,
      "rate": Double(rate),
    ]
  }

  private func emitStatus(extra: [String: Any] = [:]) {
    var body = statusBody()
    for (k, v) in extra { body[k] = v }
    emit("onVoiceStatus", body)
  }

  // MARK: Session

  /// A call (CallKit / expo-audio-session) owns the session → hands off.
  private func callOwnsSession() -> Bool {
    let mode = AVAudioSession.sharedInstance().mode
    return mode == .voiceChat || mode == .videoChat
  }

  private func headsetConnected() -> Bool {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    for o in outputs {
      switch o.portType {
      case .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .airPlay, .carAudio, .usbAudio, .lineOut, .HDMI:
        return true
      default:
        continue
      }
    }
    return false
  }

  private func configureSession(earpiece toEar: Bool) {
    if callOwnsSession() { return }
    let session = AVAudioSession.sharedInstance()
    do {
      if toEar {
        // Receiver output needs .playAndRecord; no input is opened (AVPlayer
        // only renders), so no mic indicator. Not .voiceChat on purpose —
        // that mode is our "a call owns the session" signal.
        try session.setCategory(.playAndRecord, mode: .default, options: [])
        try session.setActive(true, options: [])
        try? session.overrideOutputAudioPort(.none)
      } else {
        // .spokenAudio + no mix options = interrupts Spotify/podcasts while
        // the note plays; releaseSession() hands them the audio back.
        try session.setCategory(.playback, mode: .spokenAudio, options: [])
        try session.setActive(true, options: [])
      }
      ownsSession = true
    } catch {
      print("[VoiceNotePlayer] session config failed: \(error)")
    }
  }

  private func releaseSession() {
    guard ownsSession else { return }
    ownsSession = false
    if callOwnsSession() { return }
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      // Another player (expo-audio preview, video) still holds it — fine.
    }
  }

  private func observeSessionIfNeeded() {
    if routeObserver == nil {
      routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] note in
        guard let self = self,
              let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        if reason == .oldDeviceUnavailable && self.playing {
          // Headphones unplugged / AirPods out → pause (iOS convention).
          self.pauseInternal(reason: "route")
        } else if reason == .newDeviceAvailable {
          self.updateProximity()
        }
      }
    }
    if interruptionObserver == nil {
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        guard let self = self,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began && self.playing {
          self.pauseInternal(reason: "interruption")
        }
      }
    }
  }

  // MARK: Proximity

  private func updateProximity() {
    let device = UIDevice.current
    let shouldMonitor = proximityWanted && player != nil && (playing || earpiece)
      && !headsetConnected() && !callOwnsSession()
    if shouldMonitor {
      if !device.isProximityMonitoringEnabled {
        device.isProximityMonitoringEnabled = true
      }
      // iPads / devices without the sensor silently refuse.
      if device.isProximityMonitoringEnabled && proximityObserver == nil {
        proximityObserver = NotificationCenter.default.addObserver(
          forName: UIDevice.proximityStateDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.proximityChanged() }
      }
    } else {
      if let o = proximityObserver {
        NotificationCenter.default.removeObserver(o)
        proximityObserver = nil
      }
      // Only switch it off if we turned it on (a call screen may own it).
      if device.isProximityMonitoringEnabled && !callOwnsSession() {
        device.isProximityMonitoringEnabled = false
      }
    }
  }

  private func proximityChanged() {
    let near = UIDevice.current.proximityState
    if near && playing && !earpiece && !headsetConnected() && !callOwnsSession() {
      earpiece = true
      configureSession(earpiece: true)
      emit("onVoiceProximity", ["near": true, "earpiece": true, "token": token])
      emitStatus()
    } else if !near && earpiece {
      // WhatsApp: taking the phone away from the ear pauses the note.
      pauseInternal(reason: "proximity")
      emit("onVoiceProximity", ["near": false, "earpiece": false, "token": token])
    }
  }

  // MARK: Helpers

  static func makeURL(_ uri: String) -> URL? {
    if uri.hasPrefix("file://") {
      if let u = URL(string: uri), u.isFileURL { return u }
      return URL(fileURLWithPath: String(uri.dropFirst("file://".count)))
    }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    if let u = URL(string: uri) { return u }
    if let enc = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
      return URL(string: enc)
    }
    return nil
  }
}
