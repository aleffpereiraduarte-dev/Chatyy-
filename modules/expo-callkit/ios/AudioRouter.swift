// AudioRouter.swift — Wave B (Audio WhatsApp-grade), 2026-05-18
// [2026-10-07 audio-route] Rewritten as the SINGLE audio-route controller for
// every native call path (outgoing native-only, incoming warm/cold, lock-screen
// answer, group). See the "2026-10-07" block below for the root cause.
//
// WhatsApp pattern:
//   • Voice call  -> .playAndRecord + .voiceChat, NO .defaultToSpeaker,
//                    overrideOutputAudioPort(.none) = EARPIECE (receiver).
//                    Proximity sensor ON while the receiver is the output.
//   • Video call  -> .playAndRecord + .videoChat (implies loudspeaker) +
//                    overrideOutputAudioPort(.speaker).
//   • "Alto-falante" toggle -> overrideOutputAudioPort(.speaker / .none). In a
//                    video call "speaker OFF" also flips the mode to
//                    .voiceChat, because .videoChat's default route IS the
//                    loudspeaker (override .none would stay on speaker).
//   • Bluetooth / AirPods / wired headset win automatically (override .none
//                    lets the system pick the external route; HFP preferred
//                    for playAndRecord). Mid-call connect -> route to it;
//                    disconnect -> back to the call default / user choice.
//   • Interruptions -> after .ended re-apply mode + override (iOS resets the
//                    port override on interruption / route change).
//
// [2026-10-07 audio-route] ROOT CAUSE of "iOS voice call always on viva-voz"
// ---------------------------------------------------------------------------
// The native Room uses the LiveKit Swift SDK (LiveKitClient 2.0.18). Its
// `AudioManager.shared` reconfigures the WebRTC audio session EVERY time a
// local or remote audio track starts/stops (LocalAudioTrack.startCapture /
// RemoteAudioTrack.start → AudioManager.trackDidStart → _asyncConfigure →
// defaultConfigureAudioSessionFunc). `isSpeakerOutputPreferred` defaults to
// TRUE and nobody in this app ever touched AudioManager, so:
//   - remoteOnly   → AudioSessionConfiguration.playback
//                    (.playback + .spokenAudio + .mixWithOthers: loudspeaker,
//                    NO microphone)
//   - local / both → AudioSessionConfiguration.playAndRecordSpeaker
//                    (.playAndRecord + mode .videoChat)
// `.videoChat` implicitly behaves like `.defaultToSpeaker`, so every
// overrideOutputAudioPort(.none) we issued afterwards ("re-assert earpiece",
// 2026-10-04 TrackSubscribed +0/400/1200/2500ms) just returned to the
// mode's default route = the loudspeaker. The category was correct only
// until the first track started; LiveKit then silently flipped it.
//
// Fix: install `AudioManager.shared.customConfigureAudioSessionFunc` (public
// API in 2.0.18; once set, LiveKit no longer touches category/mode/active
// state on its own). While a call is owned by this router the hook routes to
// `applyPolicy()` (our category/mode/override, NEVER setActive — CallKit owns
// activation, LKAudioSessionCallKitBridge owns the manual-audio gate). When no
// call owns the router (LiveBroadcast / LiveViewer) the hook falls back to
// LiveKit's own `defaultConfigureAudioSessionFunc` → behaviour unchanged.
//
// The router does NOT call setActive() — CallKit owns activation.

import Foundation
import AVFoundation
import CallKit
import UIKit
import LiveKitClient

@objc final class AudioRouter: NSObject {

    @objc public static let shared = AudioRouter()

    /// [2026-10-07 audio-route] Posted on the main queue whenever the effective
    /// output changes (toggle, BT connect/disconnect, policy re-apply).
    /// userInfo: ["speakerOn": Bool, "route": "speaker"|"earpiece"|"bluetooth"|"headset"]
    static let routeDidChangeNotification = Notification.Name("ChatyyAudioRouteDidChange")

    private(set) var hasVideo: Bool = false
    /// Desired loudspeaker state (call default or user choice). The UI should
    /// prefer `isLoudspeakerActive` / the notification, which read the real route.
    private(set) var speakerOn: Bool = false
    // [2026-05-25 speaker-only fix] kept: first configure of a call always
    // runs setCategory; later ones only fix what is actually wrong.
    private var categoryConfigured = false
    private var routeObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private let lockQueue = DispatchQueue(label: "com.onemundo.mail.audioRouter")

    // [2026-10-07 audio-route] Ownership + user choice.
    /// True between prepareForCall/configureForCall and teardown().
    private var engaged = false
    private var engagedAt = Date.distantPast
    /// nil = follow the call default (video → speaker, voice → earpiece).
    private var userSpeakerChoice: Bool?
    /// Local camera currently on (voice call upgraded to video, or video call).
    private var localVideoActive = false
    private var proximitySuspended = false
    private static var liveKitHookInstalled = false
    private static let hookLock = NSLock()

    private override init() {
        super.init()
    }

    // MARK: - LiveKit AudioManager hook

    /// [2026-10-07 audio-route] Idempotent. Replaces LiveKit's default
    /// audio-session configuration (which forces `.videoChat` = loudspeaker,
    /// or `.playback` when only remote audio is live) with this router's
    /// policy for as long as a call owns the router.
    @objc static func installLiveKitAudioHook() {
        hookLock.lock()
        if liveKitHookInstalled { hookLock.unlock(); return }
        liveKitHookInstalled = true
        hookLock.unlock()
        AudioManager.shared.customConfigureAudioSessionFunc = { newState, oldState in
            // Runs on LiveKit's serial configure actor — must not block.
            let router = AudioRouter.shared
            if router.ownsCallAudio() {
                let hasTracks: Bool
                switch newState.trackState {
                case .none: hasTracks = false
                default: hasTracks = true
                }
                let local = newState.localTracksCount
                let remote = newState.remoteTracksCount
                DispatchQueue.main.async {
                    router.handleLiveKitTrackState(hasTracks: hasTracks, local: local, remote: remote)
                }
            } else {
                AudioManager.shared.defaultConfigureAudioSessionFunc(newState: newState, oldState: oldState)
            }
        }
        NSLog("[AudioRouter] LiveKit customConfigureAudioSessionFunc installed (2026-10-07 audio-route)")
    }

    /// True while a call owns the AVAudioSession. Guards against a leaked
    /// engagement (teardown missed on a force-quit / CXEnd race) hijacking a
    /// later LiveBroadcast / LiveViewer session: after 120 s with no live
    /// CallKit call the engagement is considered stale and released.
    private func ownsCallAudio() -> Bool {
        let (isEngaged, since) = lockQueue.sync { (engaged, engagedAt) }
        guard isEngaged else { return false }
        if Date().timeIntervalSince(since) < 120 { return true }
        let cxActive = CXCallObserver().calls.contains { !$0.hasEnded }
        if cxActive { return true }
        NSLog("[AudioRouter] stale engagement (no CallKit call, \(Int(Date().timeIntervalSince(since)))s) — releasing to LiveKit default")
        DispatchQueue.main.async { AudioRouter.shared.teardown() }
        return false
    }

    private func handleLiveKitTrackState(hasTracks: Bool, local: Int, remote: Int) {
        guard hasTracks else {
            // Last track stopped — CallKit's didDeactivate releases the
            // session; nothing to configure (and never setActive(false) here).
            return
        }
        print("[AudioRouter] LiveKit track state local=\(local) remote=\(remote) → applying call policy")
        applyPolicy(reason: "livekit_track")
    }

    // MARK: - Public API

    /// [2026-10-07 audio-route] Claim the session for a call as early as
    /// possible (outgoing start, CallKit answer, push answer) so the very
    /// first LiveKit track start already sees our policy. Sets category/mode
    /// (allowed on an inactive session — Apple's recommended pattern) but
    /// never activates.
    @objc public func prepareForCall(hasVideo: Bool) {
        Self.installLiveKitAudioHook()
        let fresh = lockQueue.sync { () -> Bool in
            let wasEngaged = self.engaged
            if !wasEngaged {
                self.userSpeakerChoice = nil
                self.localVideoActive = hasVideo
            }
            self.engaged = true
            self.engagedAt = Date()
            self.hasVideo = hasVideo
            if hasVideo { self.localVideoActive = true }
            if self.userSpeakerChoice == nil { self.speakerOn = hasVideo || self.localVideoActive }
            return !wasEngaged
        }
        print("[AudioRouter] prepareForCall hasVideo=\(hasVideo) fresh=\(fresh)")
        onMain {
            self.installObserversIfNeeded()
            self.applyPolicy(reason: "prepare")
        }
    }

    /// Call this at viewDidLoad of CallViewController (and equivalents) and
    /// from CallKit didActivate. Sets `.playAndRecord` + mode + BT options,
    /// then applies the route. Safe to call multiple times; a user's explicit
    /// speaker choice survives re-configuration.
    @objc public func configureForCall(hasVideo: Bool) {
        Self.installLiveKitAudioHook()
        lockQueue.sync {
            if !self.engaged {
                self.userSpeakerChoice = nil
                self.localVideoActive = hasVideo
            }
            self.engaged = true
            self.engagedAt = Date()
            self.hasVideo = hasVideo
            if hasVideo { self.localVideoActive = true }
            self.speakerOn = self.userSpeakerChoice ?? (hasVideo || self.localVideoActive)
        }
        onMain {
            self.installObserversIfNeeded()
            self.applyPolicy(reason: "configure")
        }
    }

    /// Toggle the speaker. Returns the resulting desired speaker state.
    @discardableResult
    @objc public func toggleSpeaker() -> Bool {
        let desired = !lockQueue.sync(execute: { speakerOn })
        return setSpeaker(desired)
    }

    /// Explicit speaker request (user tapped "Alto-falante", or JS
    /// ExpoCallKit.setSpeakerEnabled). Returns the resulting state.
    @discardableResult
    @objc public func setSpeaker(_ on: Bool) -> Bool {
        let isEngaged = lockQueue.sync { () -> Bool in
            self.userSpeakerChoice = on
            self.speakerOn = on
            return self.engaged
        }
        if isEngaged {
            onMain { self.applyPolicy(reason: "user_speaker_\(on)") }
        } else {
            // No native call owns the session (JS /call.js stack): keep the
            // legacy behaviour (plain port override), plus leave `.videoChat`
            // when turning the speaker OFF — otherwise override(.none) stays
            // on the loudspeaker.
            let session = AVAudioSession.sharedInstance()
            do {
                if !on, session.category == .playAndRecord, session.mode == .videoChat {
                    try session.setMode(.voiceChat)
                }
                try session.overrideOutputAudioPort(on ? .speaker : .none)
                print("[AudioRouter] speaker → \(on) (not engaged — direct override)")
            } catch {
                print("[AudioRouter] setSpeaker(\(on)) failed: \(error)")
            }
        }
        return on
    }

    /// [2026-10-07 audio-route] Re-apply the current policy WITHOUT recording a
    /// user choice (used by the post-subscribe re-assert in CallViewController).
    @objc public func reapplyRoute() {
        onMain { self.applyPolicy(reason: "reapply") }
    }

    /// [2026-10-07 audio-route] Local camera toggled. Voice call upgraded to
    /// video → loudspeaker (WhatsApp) unless the user picked a route; proximity
    /// sensor off while the camera is on.
    @objc public func setLocalVideoActive(_ active: Bool) {
        lockQueue.sync {
            self.localVideoActive = active
            if self.userSpeakerChoice == nil {
                self.speakerOn = self.hasVideo || active
            }
        }
        onMain { self.applyPolicy(reason: "local_video_\(active)") }
    }

    /// [2026-10-07 audio-route] Minimized call (chat UI visible): keep the
    /// route, but don't blank the screen via the proximity sensor.
    @objc public func setProximitySuspended(_ suspended: Bool) {
        lockQueue.sync { self.proximitySuspended = suspended }
        onMain { self.applyPolicy(reason: "proximity_suspended_\(suspended)") }
    }

    /// True when the loudspeaker is the real current output.
    @objc public var isLoudspeakerActive: Bool {
        return AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }

    /// Tear down the router at end-of-call. We do NOT setActive(false) here —
    /// CallKit's didDeactivate handles that.
    @objc public func teardown() {
        if let obs = routeObserver {
            NotificationCenter.default.removeObserver(obs)
            routeObserver = nil
        }
        if let obs = interruptionObserver {
            NotificationCenter.default.removeObserver(obs)
            interruptionObserver = nil
        }
        lockQueue.sync {
            self.hasVideo = false
            self.speakerOn = false
            self.categoryConfigured = false
            self.engaged = false
            self.userSpeakerChoice = nil
            self.localVideoActive = false
            self.proximitySuspended = false
        }
        onMain {
            self.setProximity(false)
            self.restoreWebRTCDefaultConfiguration()
            // [2026-10-09 route-picker] Next call starts on the system default.
            AudioRouter.resetPreferredInputIfNeeded()
        }
        print("[AudioRouter] teardown")
    }

    // MARK: - Policy

    private static let callOptions: AVAudioSession.CategoryOptions =
        [.allowBluetoothA2DP, .allowBluetoothHFP, .duckOthers]
    private static let bluetoothPorts: [AVAudioSession.Port] = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
    private static let wiredPorts: [AVAudioSession.Port] = [.headphones, .headsetMic, .usbAudio, .carAudio, .airPlay]

    // MARK: - WebRTC default configuration sync

    /// [2026-10-07 audio-route] WebRTC re-applies a GLOBAL default
    /// configuration (`+[LKRTCAudioSessionConfiguration webRTCConfiguration]`,
    /// captured from the AVAudioSession at class +initialize) every time its
    /// voice-processing audio unit is (re)initialized — first track start,
    /// route-change restart, post-interruption (audio_device_ios.mm
    /// UpdateAudioUnit → ConfigureAudioSession → -configureWebRTCSession: →
    /// setConfiguration:webRTCConfig active:YES). LiveKit's default configure
    /// func used to MUTATE that global object to `.videoChat` (toRTCType()
    /// returns the shared instance), so even a correct category was reverted
    /// to loudspeaker on every audio-unit restart. Keep the global in sync with
    /// our policy while a call owns the router; restore the original values on
    /// teardown so LiveBroadcast/LiveViewer behave exactly as before.
    private var savedWebRTCConfigs: [String: (String, UInt, String)] = [:]

    private static func webRTCDefaultConfig(_ className: String) -> NSObject? {
        guard let cls = NSClassFromString(className) else { return nil }
        let sel = NSSelectorFromString("webRTCConfiguration")
        guard (cls as AnyObject).responds(to: sel) else { return nil }
        return (cls as AnyObject).perform(sel)?.takeUnretainedValue() as? NSObject
    }

    private static let webRTCConfigClasses = ["LKRTCAudioSessionConfiguration", "RTCAudioSessionConfiguration"]

    private func syncWebRTCDefaultConfiguration(mode: AVAudioSession.Mode) {
        for name in Self.webRTCConfigClasses {
            guard let cfg = Self.webRTCDefaultConfig(name) else { continue }
            if savedWebRTCConfigs[name] == nil {
                let cat = (cfg.value(forKey: "category") as? String) ?? AVAudioSession.Category.soloAmbient.rawValue
                let opts = (cfg.value(forKey: "categoryOptions") as? NSNumber)?.uintValue ?? 0
                let md = (cfg.value(forKey: "mode") as? String) ?? AVAudioSession.Mode.default.rawValue
                savedWebRTCConfigs[name] = (cat, opts, md)
            }
            cfg.setValue(AVAudioSession.Category.playAndRecord.rawValue, forKey: "category")
            cfg.setValue(NSNumber(value: Self.callOptions.rawValue), forKey: "categoryOptions")
            cfg.setValue(mode.rawValue, forKey: "mode")
        }
    }

    private func restoreWebRTCDefaultConfiguration() {
        for (name, saved) in savedWebRTCConfigs {
            guard let cfg = Self.webRTCDefaultConfig(name) else { continue }
            cfg.setValue(saved.0, forKey: "category")
            cfg.setValue(NSNumber(value: saved.1), forKey: "categoryOptions")
            cfg.setValue(saved.2, forKey: "mode")
        }
        savedWebRTCConfigs.removeAll()
    }

    /// The single place that decides category / mode / port override /
    /// proximity. Main thread. Only touches what is actually different, so it
    /// is cheap and loop-free when called from route-change notifications.
    /// Effective target for the current state + route.
    ///  - speaker: force the loudspeaker. A headset/AirPods/BT present wins
    ///    over the call-type DEFAULT (video → speaker) but not over an
    ///    explicit user tap on "Alto-falante".
    ///  - mode: `.videoChat` only while it agrees with the loudspeaker; a
    ///    video call with the speaker OFF must be `.voiceChat`, otherwise the
    ///    mode's implicit loudspeaker default wins over override(.none).
    private func target() -> (speaker: Bool, mode: AVAudioSession.Mode) {
        let (wantSpeaker, choice, isVideoCall) = lockQueue.sync { (speakerOn, userSpeakerChoice, hasVideo) }
        let external = currentRouteIsExternal()
        let speaker = wantSpeaker && !(external && choice == nil)
        let mode: AVAudioSession.Mode = (isVideoCall && speaker) ? .videoChat : .voiceChat
        return (speaker, mode)
    }

    private func applyPolicy(reason: String) {
        let (isEngaged, isVideoCall, camOn, proxSuspended) = lockQueue.sync {
            (engaged, hasVideo, localVideoActive, proximitySuspended)
        }
        guard isEngaged else { return }
        let session = AVAudioSession.sharedInstance()
        let external = currentRouteIsExternal()
        let (wantSpeaker, desiredMode) = target()

        syncWebRTCDefaultConfiguration(mode: desiredMode)
        let firstTime = lockQueue.sync { !categoryConfigured }
        let categoryWrong = session.category != .playAndRecord
            || !session.categoryOptions.contains(.allowBluetoothHFP)
            || session.categoryOptions.contains(.defaultToSpeaker)
            || session.categoryOptions.contains(.mixWithOthers)
        do {
            if firstTime || categoryWrong {
                try session.setCategory(.playAndRecord, mode: desiredMode, options: Self.callOptions)
                lockQueue.sync { self.categoryConfigured = true }
                if firstTime {
                    // Mono input hint only (VPIO owns rate/buffer — 2026-05-25 chiado fix).
                    try? session.setPreferredInputNumberOfChannels(1)
                }
                print("[AudioRouter] setCategory playAndRecord mode=\(desiredMode.rawValue) (\(reason)) firstTime=\(firstTime) wasCat=\(session.category.rawValue)")
            } else if session.mode != desiredMode {
                try session.setMode(desiredMode)
                print("[AudioRouter] setMode \(desiredMode.rawValue) (\(reason))")
            }
        } catch {
            print("[AudioRouter] category/mode failed (\(reason)): \(error)")
        }

        // Port override. External device (BT / wired / AirPods) wins unless
        // the user explicitly asked for the loudspeaker (see target()).
        let port: AVAudioSession.PortOverride = wantSpeaker ? .speaker : .none
        do {
            try session.overrideOutputAudioPort(port)
        } catch {
            print("[AudioRouter] overrideOutputAudioPort(\(wantSpeaker ? "speaker" : "none")) failed (\(reason)): \(error)")
        }
        if external && !wantSpeaker {
            print("[AudioRouter] external route active (\(session.currentRoute.outputs.map { $0.portType.rawValue })) — headset wins")
        }
        // Proximity: voice call, no camera, audio on the receiver.
        let onReceiver = session.currentRoute.outputs.contains { $0.portType == .builtInReceiver }
        setProximity(!proxSuspended && !camOn && !isVideoCall && !wantSpeaker && (onReceiver || !external))
        print("[AudioRouter] policy(\(reason)) video=\(isVideoCall) cam=\(camOn) speaker=\(wantSpeaker) mode=\(session.mode.rawValue) outputs=\(session.currentRoute.outputs.map { $0.portType.rawValue })")
        postRouteChanged()
    }

    private func setProximity(_ on: Bool) {
        let device = UIDevice.current
        if device.isProximityMonitoringEnabled != on {
            device.isProximityMonitoringEnabled = on
            print("[AudioRouter] proximity monitoring → \(on)")
        }
    }

    private func currentRouteName() -> String {
        let outs = AVAudioSession.sharedInstance().currentRoute.outputs
        if outs.contains(where: { $0.portType == .builtInSpeaker }) { return "speaker" }
        if outs.contains(where: { Self.bluetoothPorts.contains($0.portType) }) { return "bluetooth" }
        if outs.contains(where: { Self.wiredPorts.contains($0.portType) }) { return "headset" }
        return "earpiece"
    }

    private func postRouteChanged() {
        let route = currentRouteName()
        let speaker: Bool = {
            if route == "speaker" { return true }
            if route == "earpiece" {
                // Session may not be active yet (ring window) → report desire.
                let outs = AVAudioSession.sharedInstance().currentRoute.outputs
                if outs.isEmpty { return lockQueue.sync { speakerOn } }
            }
            return false
        }()
        NotificationCenter.default.post(
            name: Self.routeDidChangeNotification,
            object: nil,
            userInfo: ["speakerOn": speaker, "route": route]
        )
    }

    // MARK: - Observers (route change + interruption)

    private func installObserversIfNeeded() {
        if routeObserver == nil {
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                self?.handleRouteChange(note)
            }
        }
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                guard let info = note.userInfo,
                      let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
                // iOS resets the port override on interruption. CallViewController
                // re-activates the session on .ended; re-apply our route right after.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self?.applyPolicy(reason: "interruption_ended")
                }
            }
        }
    }

    /// WhatsApp behaviour:
    ///   - new device (BT connect / headset in) -> route to it (drop any
    ///     loudspeaker override, unless the call is video with speaker default
    ///     and no user choice — headset still wins there too).
    ///   - old device gone -> back to the user choice / call default.
    ///   - category/mode/override changed by someone else -> self-heal.
    private func handleRouteChange(_ note: Notification) {
        guard let userInfo = note.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        let session = AVAudioSession.sharedInstance()
        let outs = session.currentRoute.outputs.map { $0.portType.rawValue }
        print("[AudioRouter] routeChange reason=\(reason.rawValue) outputs=\(outs)")
        guard lockQueue.sync(execute: { engaged }) else { return }

        switch reason {
        case .newDeviceAvailable:
            if currentRouteIsExternal() {
                // Headset / AirPods just connected: it wins over both the
                // earpiece and the loudspeaker (a new device is an explicit
                // user action), so drop the speaker state.
                lockQueue.sync {
                    self.speakerOn = false
                    self.userSpeakerChoice = nil
                }
                applyPolicy(reason: "new_device")
            } else {
                postRouteChanged()
            }
        case .oldDeviceUnavailable:
            lockQueue.sync {
                self.speakerOn = self.userSpeakerChoice ?? (self.hasVideo || self.localVideoActive)
            }
            applyPolicy(reason: "old_device_gone")
        case .categoryChange, .override, .routeConfigurationChange:
            // Self-heal: if someone (LiveKit, expo-audio, RN WebRTC) changed
            // category/mode behind our back, applyPolicy restores it; if
            // nothing differs it only re-sets the same override + posts UI.
            let (wantSpeaker, desiredMode) = target()
            let drift = session.category != .playAndRecord
                || session.mode != desiredMode
                || session.categoryOptions.contains(.defaultToSpeaker)
                || (!wantSpeaker && !currentRouteIsExternal()
                    && session.currentRoute.outputs.contains { $0.portType == .builtInSpeaker })
            if drift && allowSelfHeal() {
                print("[AudioRouter] drift detected (cat=\(session.category.rawValue) mode=\(session.mode.rawValue)) — re-applying")
                applyPolicy(reason: "self_heal")
            } else {
                postRouteChanged()
            }
        default:
            postRouteChanged()
        }
    }

    /// Loop breaker: at most 3 self-heals per 3 s window (our own
    /// setCategory/override also fire routeChange notifications).
    private var selfHealWindowStart = Date.distantPast
    private var selfHealCount = 0
    private func allowSelfHeal() -> Bool {
        let now = Date()
        if now.timeIntervalSince(selfHealWindowStart) > 3 {
            selfHealWindowStart = now
            selfHealCount = 0
        }
        selfHealCount += 1
        return selfHealCount <= 3
    }

    private func currentRouteIsExternal() -> Bool {
        let session = AVAudioSession.sharedInstance()
        return session.currentRoute.outputs.contains { port in
            switch port.portType {
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
                 .headphones, .headsetMic, .usbAudio, .carAudio, .airPlay:
                return true
            default:
                return false
            }
        }
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }
}
