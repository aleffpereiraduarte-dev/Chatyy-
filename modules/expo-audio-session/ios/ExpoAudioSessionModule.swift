import ExpoModulesCore
import AVFoundation
import UIKit

/// ExpoAudioSessionModule
///
/// Native AVAudioSession control for VoIP calls. The whole point is the
/// `deactivate()` call at the end: setActive(false, options: .notifyOthersOnDeactivation)
/// — without this, Spotify/Music/podcasts stay paused after the call ends.
///
/// Lifecycle, in order:
///   1. Call incoming → activateForRingtone() (category: .ambient, respects mute switch)
///   2. Call accepted → activateForCall(useSpeaker: false) (category: .playAndRecord, mode: .voiceChat)
///   3. User toggles speaker → setSpeaker(true/false)
///   4. Call ends → deactivate() with notifyOthersOnDeactivation
///
/// Skype/WhatsApp do exactly this. Without the deactivate notify, the audio
/// session leaks and other apps don't get their session back.

public class ExpoAudioSessionModule: Module {
    /// All AVAudioSession mutations are funneled through this serial queue.
    /// Without it, two JS calls (e.g. activateForCall + setSpeaker, or two
    /// rapid setSpeaker toggles) could interleave and leave the route in
    /// the wrong state — manifesting as "speaker won't switch" or
    /// "Bluetooth keeps flapping" mid-call.
    private static let sessionQueue = DispatchQueue(label: "com.onemundo.audiosession.serial")

    /// Synchronously runs an AVAudioSession mutation block on the serial
    /// queue. Bool result is propagated back.
    private static func runOnSessionQueue(_ block: () -> Bool) -> Bool {
        return sessionQueue.sync(execute: block)
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoAudioSession")

        AsyncFunction("activateForCall") { (useSpeaker: Bool) -> Bool in
            return ExpoAudioSessionModule.runOnSessionQueue {
                let session = AVAudioSession.sharedInstance()
                do {
                    // Voice calls: HFP only (A2DP is for music streaming, not voice)
                    var options: AVAudioSession.CategoryOptions = [
                        .allowBluetoothHFP,
                    ]
                    if useSpeaker {
                        options.insert(.defaultToSpeaker)
                    }
                    try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
                    try session.setActive(true, options: [])
                    if useSpeaker {
                        try? session.overrideOutputAudioPort(.speaker)
                    } else {
                        try? session.overrideOutputAudioPort(.none)
                    }
                    return true
                } catch {
                    print("[AudioSession] activateForCall failed: \(error)")
                    return false
                }
            }
        }

        AsyncFunction("activateForVideoCall") { () -> Bool in
            return ExpoAudioSessionModule.runOnSessionQueue {
                let session = AVAudioSession.sharedInstance()
                do {
                    let options: AVAudioSession.CategoryOptions = [
                        .allowBluetoothHFP,
                        .allowBluetoothA2DP,
                        .defaultToSpeaker,
                    ]
                    try session.setCategory(.playAndRecord, mode: .videoChat, options: options)
                    try session.setActive(true, options: [])
                    try? session.overrideOutputAudioPort(.speaker)
                    return true
                } catch {
                    print("[AudioSession] activateForVideoCall failed: \(error)")
                    return false
                }
            }
        }

        AsyncFunction("setSpeaker") { (enabled: Bool) -> Bool in
            return ExpoAudioSessionModule.runOnSessionQueue {
                let session = AVAudioSession.sharedInstance()
                do {
                    try session.overrideOutputAudioPort(enabled ? .speaker : .none)
                    return true
                } catch {
                    print("[AudioSession] setSpeaker failed: \(error)")
                    return false
                }
            }
        }

        AsyncFunction("deactivate") { () -> Bool in
            return ExpoAudioSessionModule.runOnSessionQueue {
                let session = AVAudioSession.sharedInstance()
                do {
                    // Reset to a benign category before deactivating so the next
                    // app to grab the session doesn't inherit playAndRecord.
                    try session.setCategory(.ambient, mode: .default, options: [])
                    // ⭐ THE FIX: notifyOthersOnDeactivation tells Spotify/Music to resume
                    try session.setActive(false, options: [.notifyOthersOnDeactivation])
                    return true
                } catch {
                    print("[AudioSession] deactivate failed: \(error)")
                    return false
                }
            }
        }

        AsyncFunction("activateForRingtone") { () -> Bool in
            return ExpoAudioSessionModule.runOnSessionQueue {
                let session = AVAudioSession.sharedInstance()
                do {
                    // Ringtone uses .ambient so it respects the silent switch
                    // (just like WhatsApp/Skype incoming call sounds).
                    try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
                    try session.setActive(true, options: [])
                    return true
                } catch {
                    print("[AudioSession] activateForRingtone failed: \(error)")
                    return false
                }
            }
        }

        Function("getCurrentCategory") { () -> String in
            let session = AVAudioSession.sharedInstance()
            return "\(session.category.rawValue) / \(session.mode.rawValue)"
        }

        /// Detect if a Bluetooth headset (HFP/A2DP) is connected.
        /// JS uses this to show a Bluetooth icon on the call screen
        /// and to auto-route audio to the headset.
        Function("isBluetoothConnectedSync") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            let outputs = session.currentRoute.outputs
            for output in outputs {
                if output.portType == .bluetoothHFP ||
                   output.portType == .bluetoothA2DP ||
                   output.portType == .bluetoothLE {
                    return true
                }
            }
            return false
        }

        /// Enable the proximity sensor during a call so iOS blanks the
        /// screen when the user holds the phone to their ear (WhatsApp /
        /// native Phone app behavior). Must be called AFTER activateForCall
        /// and disabled in deactivate.
        Function("enableProximitySensor") { (enabled: Bool) -> Void in
            DispatchQueue.main.async {
                UIDevice.current.isProximityMonitoringEnabled = enabled
            }
        }

        /// Returns the current audio output route info for the call UI.
        Function("getAudioRouteSync") { () -> [String: Any] in
            let session = AVAudioSession.sharedInstance()
            let outputs = session.currentRoute.outputs
            var routeType = "receiver"
            var portName = ""
            for output in outputs {
                portName = output.portName
                switch output.portType {
                case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE:
                    routeType = "bluetooth"
                case .builtInSpeaker:
                    routeType = "speaker"
                case .headphones:
                    routeType = "headphones"
                case .builtInReceiver:
                    routeType = "receiver"
                default:
                    routeType = "other"
                }
            }
            return [
                "type": routeType,
                "name": portName,
                "isBluetooth": routeType == "bluetooth",
            ]
        }
    }
}
