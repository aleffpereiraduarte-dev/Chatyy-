import ExpoModulesCore
import AVFoundation

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
    public func definition() -> ModuleDefinition {
        Name("ExpoAudioSession")

        AsyncFunction("activateForCall") { (useSpeaker: Bool) -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                var options: AVAudioSession.CategoryOptions = [
                    .allowBluetoothHFP,
                    .allowBluetoothA2DP,
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

        AsyncFunction("activateForVideoCall") { () -> Bool in
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

        AsyncFunction("setSpeaker") { (enabled: Bool) -> Void in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.overrideOutputAudioPort(enabled ? .speaker : .none)
            } catch {
                print("[AudioSession] setSpeaker failed: \(error)")
            }
        }

        AsyncFunction("deactivate") { () -> Void in
            let session = AVAudioSession.sharedInstance()
            do {
                // Reset to a benign category before deactivating so the next
                // app to grab the session doesn't inherit playAndRecord.
                try session.setCategory(.ambient, mode: .default, options: [])
                // ⭐ THE FIX: notifyOthersOnDeactivation tells Spotify/Music to resume
                try session.setActive(false, options: [.notifyOthersOnDeactivation])
            } catch {
                print("[AudioSession] deactivate failed: \(error)")
            }
        }

        AsyncFunction("activateForRingtone") { () -> Void in
            let session = AVAudioSession.sharedInstance()
            do {
                // Ringtone uses .ambient so it respects the silent switch
                // (just like WhatsApp/Skype incoming call sounds).
                try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
                try session.setActive(true, options: [])
            } catch {
                print("[AudioSession] activateForRingtone failed: \(error)")
            }
        }

        Function("getCurrentCategory") { () -> String in
            let session = AVAudioSession.sharedInstance()
            return "\(session.category.rawValue) / \(session.mode.rawValue)"
        }
    }
}
