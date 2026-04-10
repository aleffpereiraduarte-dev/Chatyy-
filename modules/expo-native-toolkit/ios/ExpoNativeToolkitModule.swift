import ExpoModulesCore
import Foundation
import Network
import CoreHaptics
import UIKit
import Speech
import os

/// ExpoNativeToolkitModule
/// Reachability + Haptics + Voice transcription in one place.

public class ExpoNativeToolkitModule: Module {
    private var monitor = NWPathMonitor()
    private var monitorQueue = DispatchQueue(label: "com.chatyy.toolkit.monitor")
    private var monitorStarted = false
    private var _lastPath: NWPath?
    private let lastPathLock: os_unfair_lock_t = {
        let lock = os_unfair_lock_t.allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock_s())
        return lock
    }()
    private var hapticEngine: CHHapticEngine?

    private var lastPath: NWPath? {
        get {
            os_unfair_lock_lock(lastPathLock)
            let val = _lastPath
            os_unfair_lock_unlock(lastPathLock)
            return val
        }
        set {
            os_unfair_lock_lock(lastPathLock)
            _lastPath = newValue
            os_unfair_lock_unlock(lastPathLock)
        }
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeToolkit")

        OnCreate {
            // Start reachability monitor immediately so isOnlineSync is always fresh
            self.monitor.pathUpdateHandler = { [weak self] path in
                self?.lastPath = path
            }
            self.monitor.start(queue: self.monitorQueue)
            self.monitorStarted = true

            // Pre-warm Core Haptics engine
            if CHHapticEngine.capabilitiesForHardware().supportsHaptics {
                self.hapticEngine = try? CHHapticEngine()
                try? self.hapticEngine?.start()
            }
        }

        // ─── Reachability ────────────────────────────────────────────
        Function("isOnlineSync") { () -> Bool in
            return self.lastPath?.status == .satisfied
        }

        Function("connectionTypeSync") { () -> String in
            guard let path = self.lastPath else { return "none" }
            if path.status != .satisfied { return "none" }
            if path.usesInterfaceType(.wifi) { return "wifi" }
            if path.usesInterfaceType(.cellular) { return "cellular" }
            if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
            return "other"
        }

        AsyncFunction("startReachability") { () -> Void in
            if !self.monitorStarted {
                // NWPathMonitor can't be restarted after cancel, must recreate
                self.monitor = NWPathMonitor()
                self.monitor.pathUpdateHandler = { [weak self] path in
                    self?.lastPath = path
                }
                self.monitor.start(queue: self.monitorQueue)
                self.monitorStarted = true
            }
        }
        AsyncFunction("stopReachability") { () -> Void in
            self.monitor.cancel()
            self.monitorStarted = false
        }

        // ─── Core Haptics ────────────────────────────────────────────
        Function("hapticImpact") { (intensity: String) -> Void in
            DispatchQueue.main.async {
                let style: UIImpactFeedbackGenerator.FeedbackStyle = {
                    switch intensity {
                    case "light": return .light
                    case "medium": return .medium
                    case "heavy": return .heavy
                    case "rigid": return .rigid
                    case "soft": return .soft
                    default: return .medium
                    }
                }()
                UIImpactFeedbackGenerator(style: style).impactOccurred()
            }
        }

        Function("hapticNotification") { (kind: String) -> Void in
            DispatchQueue.main.async {
                let type: UINotificationFeedbackGenerator.FeedbackType = {
                    switch kind {
                    case "success": return .success
                    case "warning": return .warning
                    case "error": return .error
                    default: return .success
                    }
                }()
                UINotificationFeedbackGenerator().notificationOccurred(type)
            }
        }

        AsyncFunction("hapticPattern") { (events: [[String: Any]]) -> Void in
            guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
            do {
                if self.hapticEngine == nil {
                    self.hapticEngine = try CHHapticEngine()
                    try self.hapticEngine?.start()
                }
                let chEvents = events.compactMap { e -> CHHapticEvent? in
                    let time = (e["time"] as? Double) ?? 0
                    let intensity = Float((e["intensity"] as? Double) ?? 1)
                    let sharpness = Float((e["sharpness"] as? Double) ?? 0.5)
                    return CHHapticEvent(
                        eventType: .hapticTransient,
                        parameters: [
                            CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                            CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
                        ],
                        relativeTime: time
                    )
                }
                let pattern = try CHHapticPattern(events: chEvents, parameters: [])
                let player = try self.hapticEngine?.makePlayer(with: pattern)
                try player?.start(atTime: CHHapticTimeImmediate)
            } catch {
                print("[Toolkit] haptic error: \(error)")
            }
        }

        // ─── Voice transcription (SFSpeechRecognizer) ───────────────
        AsyncFunction("requestSpeechPermission") { () -> Bool in
            return await withCheckedContinuation { cont in
                SFSpeechRecognizer.requestAuthorization { status in
                    cont.resume(returning: status == .authorized)
                }
            }
        }

        AsyncFunction("transcribeAudioFile") { (fileUrl: String, locale: String?) -> String in
            let lang = locale ?? "pt-BR"
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)),
                  recognizer.isAvailable else { return "" }
            let url: URL
            if fileUrl.hasPrefix("/") {
                url = URL(fileURLWithPath: fileUrl)
            } else if fileUrl.hasPrefix("file://") {
                url = URL(fileURLWithPath: fileUrl.replacingOccurrences(of: "file://", with: ""))
            } else if let parsed = URL(string: fileUrl) {
                url = parsed
            } else { return "" }
            let request = SFSpeechURLRecognitionRequest(url: url)
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = false
            return await withCheckedContinuation { cont in
                // BUG 5 FIX: Protect resumed flag with NSLock to prevent
                // double-resume crash from concurrent callback + timeout.
                let resumeLock = NSLock()
                var resumed = false
                recognizer.recognitionTask(with: request) { result, error in
                    resumeLock.lock()
                    guard !resumed else { resumeLock.unlock(); return }
                    if let result = result, result.isFinal {
                        resumed = true
                        resumeLock.unlock()
                        cont.resume(returning: result.bestTranscription.formattedString)
                    } else if error != nil {
                        resumed = true
                        resumeLock.unlock()
                        cont.resume(returning: "")
                    } else {
                        resumeLock.unlock()
                    }
                }
                // Safety timeout: resume with empty string after 30s if callback never fires
                DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
                    resumeLock.lock()
                    guard !resumed else { resumeLock.unlock(); return }
                    resumed = true
                    resumeLock.unlock()
                    cont.resume(returning: "")
                }
            }
        }
    }
}
