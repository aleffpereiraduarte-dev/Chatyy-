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

    /// [2026-10-07 voice-native] Voice-note player (AVPlayer + proximity →
    /// earpiece). Created lazily on the main queue by the first voice* call.
    private var voicePlayer: VoiceNotePlayer?
    /// [2026-10-09 media-native] Lock-screen / Control Center controls.
    private var voiceNowPlaying: VoiceNowPlaying?
    private func voice() -> VoiceNotePlayer {
        if let v = voicePlayer { return v }
        let v = VoiceNotePlayer(emit: { [weak self] name, body in
            if name == "onVoiceStatus" { self?.voiceNowPlaying?.onStatus(body) }
            self?.sendEvent(name, body)
        })
        voicePlayer = v
        voiceNowPlaying = VoiceNowPlaying(player: v)
        return v
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeAudio")

        // [2026-10-07 voice-native] voice-note player events.
        Events("onVoiceStatus", "onVoiceProximity")

        OnDestroy {
            DispatchQueue.main.async { [weak self] in
                self?.voiceNowPlaying?.clear()
                self?.voiceNowPlaying = nil
                self?.voicePlayer?.release()
                self?.voicePlayer = nil
            }
        }

        // ── [2026-10-07 voice-native] Voice-note playback ───────────────
        // JS: services/voiceNotePlayer.js (feature-detects `voicePlay`; older
        // binaries fall back to expo-audio). All on main: AVPlayer + UIDevice
        // proximity + AVAudioSession notifications are main-thread APIs.
        AsyncFunction("voicePlay") { (uri: String, startMs: Double, rate: Double, token: Int) throws -> Void in
            try self.voice().play(uri: uri, startMs: startMs, rate: rate, token: token)
        }.runOnQueue(.main)

        AsyncFunction("voicePause") { () -> Void in
            self.voicePlayer?.pause()
        }.runOnQueue(.main)

        AsyncFunction("voiceResume") { () -> Void in
            self.voicePlayer?.resume()
        }.runOnQueue(.main)

        AsyncFunction("voiceSeek") { (ms: Double) -> Void in
            self.voicePlayer?.seek(ms: ms)
        }.runOnQueue(.main)

        AsyncFunction("voiceSetRate") { (rate: Double) -> Void in
            self.voicePlayer?.setRate(rate)
        }.runOnQueue(.main)

        AsyncFunction("voiceStop") { () -> Void in
            self.voicePlayer?.stop()
            self.voiceNowPlaying?.clear()
        }.runOnQueue(.main)

        // [2026-10-09 media-native] Lock-screen metadata for the playing note:
        // { title?, subtitle?, artworkUri?, enabled? }. Optional — without it
        // the lock screen shows the app name.
        AsyncFunction("voiceSetNowPlaying") { (meta: [String: Any]) -> Void in
            _ = self.voice()
            self.voiceNowPlaying?.setMetadata(meta)
        }.runOnQueue(.main)

        AsyncFunction("voiceSetProximityEnabled") { (enabled: Bool) -> Void in
            self.voice().setProximityEnabled(enabled)
        }.runOnQueue(.main)

        AsyncFunction("voiceGetStatus") { () -> [String: Any] in
            return self.voicePlayer?.status() ?? ["playing": false, "positionMs": 0, "durationMs": 0, "token": 0, "earpiece": false]
        }.runOnQueue(.main)

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

            // [2026-10-07 send-media] Voice-note profile: AAC-LC mono 24 kHz @
            // 32 kbps (~240 KB/min; was 44.1 kHz @ 64 kbps ≈ 480 KB/min). Speech
            // is band-limited — no audible loss, half the upload. Stays AAC/m4a
            // (not WhatsApp's Ogg/Opus) because AVPlayer can't play Ogg and every
            // existing player/cache path expects m4a — old notes unaffected.
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 24000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
                AVEncoderBitRateKey: 32000,
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
