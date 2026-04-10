import ExpoModulesCore
import AVFoundation

/// ExpoNativeAudioModule
/// Native voice recording with AVAudioEngine + waveform sampling.
/// Replaces expo-audio for voice messages: same API, native quality.

public class ExpoNativeAudioModule: Module {
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var levelMeter: Timer?
    private var samples: [Float] = []
    private var startedAt: TimeInterval = 0
    private var currentLevel: Float = 0

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeAudio")

        AsyncFunction("startRecording") { () -> String in
            // Prevent concurrent recordings
            guard self.recorder == nil else {
                throw NSError(domain: "Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Already recording"])
            }

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
            self.recorder = try AVAudioRecorder(url: path, settings: settings)
            self.recorder?.isMeteringEnabled = true
            self.recorder?.prepareToRecord()
            guard self.recorder?.record() == true else {
                self.recorder = nil
                throw NSError(domain: "Audio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to start recording"])
            }
            self.startedAt = Date().timeIntervalSince1970
            self.samples.removeAll()

            // Sample level at 30 Hz for the waveform
            // BUG 2 FIX: [weak self] to break Timer retain cycle
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.levelMeter = Timer.scheduledTimer(withTimeInterval: 1.0/30, repeats: true) { [weak self] _ in
                    guard let self = self, let r = self.recorder else { return }
                    r.updateMeters()
                    let db = r.averagePower(forChannel: 0)
                    // Convert -160dB..0 to 0..1 (with floor at -50dB for visual)
                    let normalized = max(0, min(1, (db + 50) / 50))
                    self.currentLevel = normalized
                    self.samples.append(normalized)
                }
            }
            return path.absoluteString
        }

        AsyncFunction("stopRecording") { () -> [String: Any] in
            self.levelMeter?.invalidate()
            self.levelMeter = nil
            self.currentLevel = 0
            let durationMs = Int((Date().timeIntervalSince1970 - self.startedAt) * 1000)
            self.recorder?.stop()
            let path = self.recorder?.url.absoluteString ?? ""
            self.recorder = nil
            return [
                "path": path,
                "durationMs": durationMs,
                "samples": self.samples,
            ]
        }

        AsyncFunction("cancelRecording") { () -> Void in
            self.levelMeter?.invalidate()
            self.levelMeter = nil
            self.currentLevel = 0
            self.recorder?.stop()
            if let url = self.recorder?.url { try? FileManager.default.removeItem(at: url) }
            self.recorder = nil
            self.samples.removeAll()
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
