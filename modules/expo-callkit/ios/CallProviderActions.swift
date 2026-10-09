// CallProviderActions.swift — [2026-10-09 system-integration] CXProvider
// action handlers shared by BOTH provider delegates:
//   * ExpoCallKitModule.ProviderDelegate (module provider), and
//   * VoipPushAppDelegateSubscriber (earlyProvider stub).
//
// Why: incoming calls are reported on `earlyProvider` (VoIP push and the
// native WS invite path), so every CXAction for those calls is delivered to
// the VoIP STUB delegate — which only implemented answer/end/audio. The
// system mute button (lock screen / call pill / CarPlay), hold ("Hold &
// Accept" when a GSM call arrives, swap) and the system keypad never reached
// the call: mute did nothing, and a hold request on an incoming-answered call
// was left unhandled.

import Foundation
import AVFoundation
import CallKit

enum CallProviderActions {
    private static func resolveCallId(_ uuid: UUID, _ hint: String?) -> String {
        if let h = hint, !h.isEmpty { return h }
        return ExpoCallKitModule.sharedCallId(forCallKitUUID: uuid) ?? uuid.uuidString
    }

    /// System mute (lock screen, call pill, CarPlay, AirPods long-press).
    /// CallViewController observes ExpoCallKitSystemMuteChanged and applies
    /// it to the LiveKit mic; ExpoCallKitLkLocalAudioChanged is forwarded to
    /// JS (onLkLocalAudioChanged) by the module observer.
    static func performMuted(_ action: CXSetMutedCallAction, callId hint: String? = nil) {
        let muted = action.isMuted
        let callId = resolveCallId(action.callUUID, hint)
        NSLog("[CallProviderActions] CXSetMuted \(muted) callId=\(callId)")
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkLocalAudioChanged"),
            object: nil,
            userInfo: ["enabled": !muted]
        )
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitSystemMuteChanged"),
            object: nil,
            userInfo: ["muted": muted, "callId": callId]
        )
        CallSessionObserver.shared.setMutedFromProvider(uuid: action.callUUID, muted: muted)
        action.fulfill()
    }

    /// Hold / resume. CallViewController observes ExpoCallKitSystemHoldChanged
    /// (mic + UI), the module forwards ExpoCallKitCallHoldChanged to JS as
    /// onCallHoldChanged, and CallHoldResumer auto-resumes a system hold
    /// once the other call ends.
    static func performHeld(_ action: CXSetHeldCallAction, callId hint: String? = nil) {
        let uuid = action.callUUID
        let callId = resolveCallId(uuid, hint)
        let held = action.isOnHold
        NSLog("[CallProviderActions] CXSetHeld \(held) callId=\(callId)")
        nativeCallDiag("callkit_hold", callId, "held=\(held ? 1 : 0)")
        CallHoldResumer.shared.noteHoldAction(uuid: uuid, onHold: held)
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitSystemHoldChanged"),
            object: nil,
            userInfo: ["held": held, "callId": callId]
        )
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitCallHoldChanged"),
            object: nil,
            userInfo: ["held": held]
        )
        let session = AVAudioSession.sharedInstance()
        if held {
            // Release audio so the other call / app can use it.
            do {
                try session.setActive(false, options: [.notifyOthersOnDeactivation])
            } catch {
                print("[CallProviderActions] hold audio deactivation failed: \(error)")
            }
        } else {
            // [2026-10-07 audio-route] category/mode/override via AudioRouter
            // so resume keeps the call type + the user's speaker choice.
            do {
                try session.setActive(true)
                AudioRouter.shared.reapplyRoute()
            } catch {
                print("[CallProviderActions] resume audio activation failed: \(error)")
                action.fail()
                return
            }
        }
        action.fulfill()
    }

    /// System keypad digits → same LK data-channel path as the in-app keypad.
    static func performDTMF(_ action: CXPlayDTMFCallAction) {
        for ch in action.digits {
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitPlayDTMF"),
                object: nil,
                userInfo: ["digit": String(ch)]
            )
        }
        action.fulfill()
    }
}
