import Foundation
import AVFoundation

/**
 * [2026-10-06 native-only outgoing] LKAudioSessionCallKitBridge
 *
 * CallKit-correct audio-unit gating for the NATIVE LiveKit Swift stack
 * (`LiveKitClient` → `LiveKitWebRTC`, ObjC class `LKRTCAudioSession`).
 *
 * Why this exists
 * ---------------
 * The module already puts react-native-webrtc's `RTCAudioSession` in manual
 * audio mode at launch and flips `isAudioEnabled` inside
 * `provider:didActivate:` (see VoipPushAppDelegateSubscriber.
 * configureRTCAudioSessionManual + ProviderDelegate.didActivate). That only
 * covers the JS LiveKit stack. The native CallViewController Room uses the
 * LiveKit Swift SDK, whose WebRTC copy is a DIFFERENT, LK-prefixed class
 * (`LKRTCAudioSession`) that was still in AUTOMATIC mode: its audio unit
 * (VPIO) starts the moment the first track starts. On an OUTGOING call the
 * Room is connected the instant the user taps "Ligar", i.e. BEFORE CallKit
 * has activated the AVAudioSession (CXStartCallAction → didActivate lands a
 * few hundred ms later). An audio unit started against a not-yet-activated
 * CallKit session is the classic "outgoing call is silent / one-way" WebRTC
 * + CallKit bug — the exact symptom seen on 2026-10-02 when /call.js was
 * removed and nothing on the JS side re-configured the session anymore.
 * The incoming path never hits it because CXAnswerCallAction → didActivate
 * runs BEFORE the VC/Room exist.
 *
 * What it does
 * ------------
 *  * `armForOutgoingCall(callId:)` — called from startOutgoingCall BEFORE the
 *    native Room is built. Puts LKRTCAudioSession in manual mode with the
 *    audio unit disabled, so nothing starts VPIO until CallKit says so.
 *  * `audioSessionDidActivate(_:)` — called from BOTH CXProvider delegates'
 *    `didActivate` (module ProviderDelegate + the VoipPush stub). Forwards
 *    the activation to WebRTC (`audioSessionDidActivate:`) and enables the
 *    audio unit. Now any track LiveKit starts (remote audio on answer, the
 *    caller mic published by openOutgoingMicGate) runs on the live
 *    CallKit-owned session.
 *  * `audioSessionDidDeactivate(_:)` — mirror on `didDeactivate`; disables
 *    the unit and DISARMS (back to automatic mode) so the non-CallKit native
 *    LK surfaces (LiveBroadcast / LiveViewer / GroupCall) are untouched.
 *  * Safety valve: if didActivate never arrives within `kFallbackSeconds`
 *    (CallKit transaction failed, delegate not bound, ...), re-enable the
 *    audio unit anyway so a call can NEVER end up fully silent because of
 *    this gate. Same for `disarm()` on start-transaction failure.
 *
 * Scope: ONLY armed for the duration of an outgoing CallKit call. Everything
 * else in the app keeps the SDK's automatic behaviour, which is what the
 * working incoming path has always used.
 *
 * Implementation notes
 * --------------------
 *  * Reflection (`NSClassFromString("LKRTCAudioSession")`) so this compiles
 *    and no-ops regardless of the exact LiveKitClient pod revision; the
 *    ObjC surface (`sharedInstance`, `useManualAudio`, `isAudioEnabled`,
 *    `audioSessionDidActivate:` / `audioSessionDidDeactivate:`) has been
 *    stable in WebRTC for years and LiveKitWebRTC only prefixes the names.
 *  * BOOL properties are set through KVC (`setValue(_:forKey:)`), which
 *    unboxes NSNumber → BOOL correctly. `perform(_:with:)` with an NSNumber
 *    passes an object pointer where a BOOL is expected (always truthy) — do
 *    not copy that pattern here.
 *  * All entry points are main-thread-safe and idempotent.
 */
enum LKAudioSessionCallKitBridge {

    private static let lock = NSLock()
    private static var armed: Bool = false
    private static var armedCallId: String = ""
    private static var fallbackWork: DispatchWorkItem?
    private static let kFallbackSeconds: Double = 6.0

    // MARK: - Reflection helpers

    private static func lkSession() -> NSObject? {
        guard let cls = NSClassFromString("LKRTCAudioSession") else { return nil }
        let sel = NSSelectorFromString("sharedInstance")
        guard (cls as AnyObject).responds(to: sel) else { return nil }
        return (cls as AnyObject).perform(sel)?.takeUnretainedValue() as? NSObject
    }

    private static func setBool(_ session: NSObject, key: String, _ value: Bool) {
        // KVC → calls the ObjC setter with a real BOOL.
        let setter = NSSelectorFromString("set" + key.prefix(1).uppercased() + String(key.dropFirst()) + ":")
        guard session.responds(to: setter) else { return }
        session.setValue(NSNumber(value: value), forKey: key)
    }

    private static func forward(_ session: NSObject, selectorName: String, _ arg: Any?) {
        let sel = NSSelectorFromString(selectorName)
        guard session.responds(to: sel) else { return }
        _ = session.perform(sel, with: arg)
    }

    // MARK: - Public API

    /// Enter manual mode with the audio unit OFF. Call BEFORE the native
    /// Room is created for an outgoing call. No-op if a native Room already
    /// exists (an audio unit may be live — never yank it mid-call).
    static func armForOutgoingCall(callId: String) {
        guard let s = lkSession() else {
            NSLog("[LKAudioBridge] LKRTCAudioSession not linked — nothing to arm (callId=\(callId))")
            return
        }
        lock.lock()
        if NativeCallRoom.shared.hasRoom() {
            lock.unlock()
            NSLog("[LKAudioBridge] skip arm — a native Room already exists (callId=\(callId))")
            return
        }
        armed = true
        armedCallId = callId
        fallbackWork?.cancel()
        let work = DispatchWorkItem {
            lock.lock()
            let stillArmed = armed && armedCallId == callId
            lock.unlock()
            guard stillArmed else { return }
            NSLog("[LKAudioBridge] didActivate never arrived in \(kFallbackSeconds)s — enabling audio unit anyway (callId=\(callId))")
            nativeCallDiag("lk_audio_bridge_fallback_enable", callId)
            if let s2 = lkSession() { setBool(s2, key: "isAudioEnabled", true) }
        }
        fallbackWork = work
        lock.unlock()
        setBool(s, key: "useManualAudio", true)
        setBool(s, key: "isAudioEnabled", false)
        DispatchQueue.main.asyncAfter(deadline: .now() + kFallbackSeconds, execute: work)
        NSLog("[LKAudioBridge] armed (manual audio, unit OFF) callId=\(callId)")
        nativeCallDiag("lk_audio_bridge_armed", callId)
    }

    /// CallKit activated the AVAudioSession. Forward + enable the audio unit.
    static func audioSessionDidActivate(_ audioSession: AVAudioSession) {
        lock.lock()
        let isArmed = armed
        let cid = armedCallId
        fallbackWork?.cancel()
        fallbackWork = nil
        lock.unlock()
        guard isArmed, let s = lkSession() else { return }
        forward(s, selectorName: "audioSessionDidActivate:", audioSession)
        setBool(s, key: "isActive", true)
        setBool(s, key: "isAudioEnabled", true)
        NSLog("[LKAudioBridge] didActivate → audio unit ON callId=\(cid)")
        nativeCallDiag("lk_audio_bridge_activated", cid)
    }

    /// CallKit released the AVAudioSession. Disable the unit and go back to
    /// automatic mode so later non-CallKit LK surfaces behave as before.
    static func audioSessionDidDeactivate(_ audioSession: AVAudioSession) {
        lock.lock()
        let isArmed = armed
        let cid = armedCallId
        lock.unlock()
        guard isArmed, let s = lkSession() else { return }
        forward(s, selectorName: "audioSessionDidDeactivate:", audioSession)
        setBool(s, key: "isAudioEnabled", false)
        disarm(reason: "didDeactivate")
        NSLog("[LKAudioBridge] didDeactivate → audio unit OFF, disarmed callId=\(cid)")
    }

    /// Restore automatic mode. Idempotent. Called on didDeactivate, on a
    /// failed CXStartCallAction and from NativeCallRoom.clear() so a torn-down
    /// call can never leave the SDK gated.
    static func disarm(reason: String) {
        lock.lock()
        let wasArmed = armed
        armed = false
        armedCallId = ""
        fallbackWork?.cancel()
        fallbackWork = nil
        lock.unlock()
        guard wasArmed, let s = lkSession() else { return }
        setBool(s, key: "useManualAudio", false)
        setBool(s, key: "isAudioEnabled", true)
        NSLog("[LKAudioBridge] disarmed (automatic mode) reason=\(reason)")
    }

    static var isArmed: Bool {
        lock.lock(); defer { lock.unlock() }
        return armed
    }
}
