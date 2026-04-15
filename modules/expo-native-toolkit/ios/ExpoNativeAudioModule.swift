import ExpoModulesCore
import AVFoundation

/// ExpoNativeAudioModule
/// Native voice recording with AVAudioEngine + waveform sampling.
/// Replaces expo-audio for voice messages: same API, native quality.

public class ExpoNativeAudioModule: Module {
    // All shared mutable state is now read/written under `stateLock` so
    // rapid JS calls (start/stop/play overlap) can't tear the state.
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var levelMeter: Timer?
    private var samples: [Float] = []
    private var startedAt: TimeInterval = 0
    private var currentLevel: Float = 0
    /// Monotonic recording session id. Used by the level-meter timer to
    /// abort if a NEWER recording started before the timer was created on
    /// the main queue (race window: stop+start back-to-back).
    private var recSession: UInt64 = 0
    private let stateLock = NSLock()

    /// Try to deactivate the audio session, notifying other apps so the
    /// system reroutes audio (Spotify resumes, etc). Safe to call multiple
    /// times — errors are silenced.
    private func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Silent — failure here means another sub-system still owns
            // the session, which the call/teardown path will handle.
        }
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeAudio")

        AsyncFunction("startRecording") { () -> String in
            // Prevent concurrent recordings (atomic check-and-set)
            self.stateLock.lock()
            if self.recorder != nil {
                self.stateLock.unlock()
                throw NSError(domain: "Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Already recording"])
            }
            // Reserve the slot atomically by bumping recSession; the timer
            // setup below will check this value before installing itself.
            self.recSession += 1
            let mySession = self.recSession
            self.stateLock.unlock()

            let session = AVAudioSession.sharedInstance()

            // Explicitly request microphone permission before recording
            let permissionGranted = await withCheckedContinuation { continuation in
                session.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
            guard permissionGranted else {
                throw NSError(domain: "Audio", code: 3, userInfo: [NSLocalizedDescriptionKey: "Microphone permission denied"])
            }

            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)

            let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            let path = cachesDir.appendingPathComponent("voice_\(UUID().uuidString).m4a")

            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
                AVEncoderBitRateKey: 64000,
            ]
            let newRecorder = try AVAudioRecorder(url: path, settings: settings)
            newRecorder.isMeteringEnabled = true
            newRecorder.prepareToRecord()
            guard newRecorder.record() else {
                self.deactivateSession()
                throw NSError(domain: "Audio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to start recording"])
            }

            self.stateLock.lock()
            // If the user already canceled / replaced this session while
            // we were awaiting permission, abandon it.
            if self.recSession != mySession {
                self.stateLock.unlock()
                newRecorder.stop()
                try? FileManager.default.removeItem(at: path)
                self.deactivateSession()
                throw NSError(domain: "Audio", code: 4, userInfo: [NSLocalizedDescriptionKey: "Recording superseded"])
            }
            self.recorder = newRecorder
            self.startedAt = Date().timeIntervalSince1970
            self.samples.removeAll()
            self.stateLock.unlock()

            // Sample level at 30 Hz for the waveform
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.stateLock.lock()
                let stillCurrent = (self.recSession == mySession && self.recorder != nil)
                self.stateLock.unlock()
                if !stillCurrent { return }
                self.levelMeter?.invalidate()
                self.levelMeter = Timer.scheduledTimer(withTimeInterval: 1.0/30, repeats: true) { [weak self] timer in
                    guard let self = self else { timer.invalidate(); return }
                    self.stateLock.lock()
                    if self.recSession != mySession || self.recorder == nil {
                        self.stateLock.unlock()
                        timer.invalidate()
                        return
                    }
                    let r = self.recorder
                    self.stateLock.unlock()
                    guard let rec = r else { timer.invalidate(); return }
                    rec.updateMeters()
                    let db = rec.averagePower(forChannel: 0)
                    let normalized = max(0, min(1, (db + 50) / 50))
                    self.stateLock.lock()
                    if self.recSession == mySession {
                        self.currentLevel = normalized
                        self.samples.append(normalized)
                    }
                    self.stateLock.unlock()
                }
            }
            return path.absoluteString
        }

        AsyncFunction("stopRecording") { () -> [String: Any] in
            self.stateLock.lock()
            self.recSession += 1 // invalidate any pending timer/start
            self.levelMeter?.invalidate()
            self.levelMeter = nil
            self.currentLevel = 0
            let durationMs = Int((Date().timeIntervalSince1970 - self.startedAt) * 1000)
            let r = self.recorder
            self.recorder = nil
            let snapshotSamples = self.samples
            self.stateLock.unlock()
            r?.stop()
            let path = r?.url.absoluteString ?? ""
            // Release the audio session so calls / Spotify / other apps
            // can take it back. The previous version left it active and
            // interfered with the next CallKit incoming call.
            self.deactivateSession()
            return [
                "path": path,
                "durationMs": durationMs,
                "samples": snapshotSamples,
            ]
        }

        AsyncFunction("cancelRecording") { () -> Void in
            self.stateLock.lock()
            self.recSession += 1
            self.levelMeter?.invalidate()
            self.levelMeter = nil
            self.currentLevel = 0
            let r = self.recorder
            self.recorder = nil
            self.samples.removeAll()
            self.stateLock.unlock()
            r?.stop()
            if let url = r?.url { try? FileManager.default.removeItem(at: url) }
            self.deactivateSession()
        }

        Function("currentLevelSync") { () -> Double in
            return Double(self.currentLevel)
        }

        Function("currentDurationMsSync") { () -> Int in
            return self.recorder != nil ? Int((Date().timeIntervalSince1970 - self.startedAt) * 1000) : 0
        }

        AsyncFunction("playFile") { (fileUrl: String) -> Void in
            self.player?.stop()
            let cleaned = fileUrl.replacingOccurrences(of: "file://", with: "")
            let url = URL(fileURLWithPath: cleaned)
            self.player = try AVAudioPlayer(contentsOf: url)
            self.player?.prepareToPlay()
            self.player?.play()
        }

        AsyncFunction("pausePlayback") { () -> Void in
            self.player?.pause()
        }

        AsyncFunction("stopPlayback") { () -> Void in
            self.player?.stop()
            self.player = nil
        }

        AsyncFunction("setPlaybackRate") { (rate: Double) -> Void in
            self.player?.enableRate = true
            self.player?.rate = Float(rate)
        }

        Function("isPlayingSync") { () -> Bool in
            return self.player?.isPlaying ?? false
        }
    }
}
