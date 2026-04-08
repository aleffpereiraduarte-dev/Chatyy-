import ExpoModulesCore
import Foundation
import Network
import CoreHaptics
import UIKit
import Speech

/// ExpoNativeToolkitModule
/// Reachability + Haptics + Voice transcription in one place.

public class ExpoNativeToolkitModule: Module {
    private let monitor = NWPathMonitor()
    private var monitorQueue = DispatchQueue(label: "com.chatyy.toolkit.monitor")
    private var lastPath: NWPath?
    private var hapticEngine: CHHapticEngine?

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeToolkit")

        OnCreate {
            // Start reachability monitor immediately so isOnlineSync is always fresh
            self.monitor.pathUpdateHandler = { [weak self] path in
                self?.lastPath = path
            }
            self.monitor.start(queue: self.monitorQueue)

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
            self.monitor.start(queue: self.monitorQueue)
        }
        AsyncFunction("stopReachability") { () -> Void in
            self.monitor.cancel()
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
            let url = URL(string: fileUrl) ?? URL(fileURLWithPath: fileUrl.replacingOccurrences(of: "file://", with: ""))
            let request = SFSpeechURLRecognitionRequest(url: url)
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = false
            return await withCheckedContinuation { cont in
                recognizer.recognitionTask(with: request) { result, error in
                    if let result = result, result.isFinal {
                        cont.resume(returning: result.bestTranscription.formattedString)
                    } else if error != nil {
                        cont.resume(returning: "")
                    }
                }
            }
        }
    }
}
