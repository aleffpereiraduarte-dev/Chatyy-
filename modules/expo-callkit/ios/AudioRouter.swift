// AudioRouter.swift — Wave B (Audio WhatsApp-grade), 2026-05-18
//
// Central helper that owns the AVAudioSession during a native call. Replaces
// the half-dozen ad-hoc `try? session.setCategory(...)` blocks that were
// scattered across CallViewController, ExpoCallKitModule, GroupCallViewController.
//
// WhatsApp pattern:
//   • Audio call  -> earpiece by default, speaker via explicit toggle.
//   • Video call  -> speaker by default.
//   • Bluetooth   -> if a BT headset (or wired headset) is connected at call
//                    start, route through it instead of the earpiece. Same on
//                    mid-call connect.
//   • Mid-call BT disconnect -> fall back to earpiece (audio) or speaker
//                                (video) — matches how WA handles AirPods
//                                yanked mid-call.
//   • Interruptions (Siri / incoming PSTN) — leave handling to
//                    ExpoCallKitModule's interruption listener (already wired).
//
// The router does NOT call setActive() — CallKit owns activation. We only
// configure the category / mode / route override after didActivate.

import Foundation
import AVFoundation

@objc final class AudioRouter: NSObject {

    @objc public static let shared = AudioRouter()

    private(set) var hasVideo: Bool = false
    private(set) var speakerOn: Bool = false
    // [2026-05-25 speaker-only fix] Set once per call, the first time we
    // configure the category. configureForCall runs TWICE per answered call
    // (CXProvider.didActivate, then CallViewController.viewDidLoad). Calling
    // setCategory() a SECOND time — after CallKit's didActivate already flipped
    // WebRTC's manual-audio gate ON and the VPIO audio unit started — silently
    // breaks the earpiece route: audio then only plays on the loudspeaker
    // ("só funciona no viva voz"). Apple's own guidance is explicit: do NOT
    // call setCategory after joining the WebRTC audio unit. So we set the
    // category exactly once; subsequent configureForCall calls only re-apply
    // the route override (overrideOutputAudioPort), which is safe mid-call.
    private var categoryConfigured = false
    private var routeObserver: NSObjectProtocol?
    private let lockQueue = DispatchQueue(label: "com.onemundo.mail.audioRouter")

    private override init() {
        super.init()
    }

    // MARK: - Public API

    /// Call this at viewDidLoad of CallViewController (and equivalents). It
    /// sets `.playAndRecord` + `.voiceChat` + the BT options that we need,
    /// then picks the initial output port (earpiece vs speaker) based on
    /// `hasVideo`. Safe to call multiple times.
    @objc public func configureForCall(hasVideo: Bool) {
        lockQueue.sync {
            self.hasVideo = hasVideo
            self.speakerOn = hasVideo  // video → speaker, audio → earpiece
        }
        let session = AVAudioSession.sharedInstance()
        // [2026-05-25 speaker-only fix] Only touch the category/mode + the
        // preferred-format hints ONCE per call. Re-running setCategory after
        // CallKit's didActivate started the WebRTC VPIO audio unit is exactly
        // what breaks the earpiece route (audio stuck on loudspeaker). On the
        // second+ configureForCall we fall straight through to applyInitialRoute
        // below, which only flips overrideOutputAudioPort — safe at any time.
        let needsCategory = lockQueue.sync { !categoryConfigured }
        if needsCategory {
            do {
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    // `.allowBluetooth` is deprecated since iOS 8; A2DP + HFP
                    // covers modern BT headsets without the warning. `.duckOthers`
                    // lowers Spotify/Podcast volume during call setup.
                    options: [.allowBluetoothA2DP, .allowBluetoothHFP, .duckOthers]
                )
                lockQueue.sync { self.categoryConfigured = true }
            } catch {
                print("[AudioRouter] setCategory failed: \(error)")
            }

            // [2026-05-25 CHIADO FIX] REMOVED setPreferredSampleRate(48k) +
            // setPreferredIOBufferDuration(0.01). With `.voiceChat` mode the
            // system runs the Voice-Processing I/O (VPIO) audio unit — Apple's
            // hardware AEC/AGC/NS. VPIO owns its own sample rate + buffer size;
            // forcing a 10ms IO buffer (WAVE 44B) makes the render callback miss
            // its deadline on real hardware → buffer underruns → the loud
            // crackle/static the user reported ("chiado enorme"). Letting VPIO
            // pick its native format is the WhatsApp/Telegram-grade default and
            // eliminates the crackle. We keep ONLY the mono input hint (safe,
            // and what the voice codec wants).
            do {
                try session.setPreferredInputNumberOfChannels(1)
            } catch {
                // Some BT headsets only expose stereo — non-fatal, LK downmixes.
                print("[AudioRouter] setPreferredInputNumberOfChannels failed: \(error)")
            }
            print("[AudioRouter] category configured (once, VPIO-managed format): rate=\(session.sampleRate)Hz buf=\(session.ioBufferDuration)s inCh=\(session.inputNumberOfChannels)")
        } else {
            print("[AudioRouter] category already configured — skipping setCategory (re-applying route only, avoids breaking VPIO earpiece route)")
        }

        // Pick the initial route. If a wired/BT headset is connected we let
        // that win (don't override). Otherwise: speaker for video, earpiece
        // (port .none) for audio.
        applyInitialRoute()
        installRouteObserverIfNeeded()
    }

    /// Toggle the speaker. CallView / CallActivity wires the UI button here.
    /// Returns the resulting speaker state (post-toggle).
    @discardableResult
    @objc public func toggleSpeaker() -> Bool {
        let desired = !lockQueue.sync(execute: { speakerOn })
        return setSpeaker(desired)
    }

    /// Explicitly request speaker on/off. Returns the resulting state.
    @discardableResult
    @objc public func setSpeaker(_ on: Bool) -> Bool {
        lockQueue.sync { self.speakerOn = on }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.overrideOutputAudioPort(on ? .speaker : .none)
            print("[AudioRouter] speaker → \(on)")
        } catch {
            print("[AudioRouter] setSpeaker(\(on)) failed: \(error)")
        }
        return on
    }

    /// Tear down the router at end-of-call. We do NOT setActive(false) here —
    /// CallKit's didDeactivate handles that and bumps the WebRTC manual-audio
    /// gate down.
    @objc public func teardown() {
        if let obs = routeObserver {
            NotificationCenter.default.removeObserver(obs)
            routeObserver = nil
        }
        lockQueue.sync {
            self.hasVideo = false
            self.speakerOn = false
            // Reset so the NEXT call re-runs setCategory exactly once.
            self.categoryConfigured = false
        }
        print("[AudioRouter] teardown")
    }

    // MARK: - Initial routing

    /// If a headphone (wired or BT) is in the current route, leave it alone.
    /// Otherwise apply the policy: speaker if video, earpiece if audio.
    private func applyInitialRoute() {
        let session = AVAudioSession.sharedInstance()
        let currentOutputs = session.currentRoute.outputs
        let externalConnected = currentOutputs.contains { port in
            switch port.portType {
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
                 .headphones, .headsetMic, .usbAudio, .carAudio, .airPlay:
                return true
            default:
                return false
            }
        }
        if externalConnected {
            print("[AudioRouter] external audio device present (\(currentOutputs.map { $0.portType.rawValue })), leaving route alone")
            // Make sure speakerOn reflects reality (false — audio is going
            // through the headset, not the loudspeaker).
            lockQueue.sync { self.speakerOn = false }
            // Clear any prior loudspeaker override so the headset wins.
            try? session.overrideOutputAudioPort(.none)
            return
        }
        let wantSpeaker = lockQueue.sync(execute: { hasVideo })
        do {
            try session.overrideOutputAudioPort(wantSpeaker ? .speaker : .none)
            lockQueue.sync { self.speakerOn = wantSpeaker }
            print("[AudioRouter] initial route → \(wantSpeaker ? "speaker" : "earpiece") hasVideo=\(wantSpeaker)")
        } catch {
            print("[AudioRouter] initial overrideOutputAudioPort failed: \(error)")
        }
    }

    // MARK: - Route change listener (BT / wired headset hot-plug)

    private func installRouteObserverIfNeeded() {
        if routeObserver != nil { return }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleRouteChange(note)
        }
    }

    /// Handle BT / wired headset hot-plug events. WhatsApp behaviour:
    ///   - new device available (BT connect / headset in)  -> route to it.
    ///   - old device unavailable (BT disconnect / unplug) -> fall back to
    ///                                  the call-type default (speaker on
    ///                                  video, earpiece on audio). Don't
    ///                                  surprise the user with speakerphone
    ///                                  mid-call if they had set earpiece.
    private func handleRouteChange(_ note: Notification) {
        guard let userInfo = note.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        let session = AVAudioSession.sharedInstance()
        let outs = session.currentRoute.outputs.map { $0.portType.rawValue }
        print("[AudioRouter] routeChange reason=\(reason.rawValue) outputs=\(outs)")

        switch reason {
        case .newDeviceAvailable:
            // BT headset / wired headset just connected. Route to it by
            // clearing any speakerphone override.
            if currentRouteIsExternal() {
                try? session.overrideOutputAudioPort(.none)
                lockQueue.sync { self.speakerOn = false }
                print("[AudioRouter] newDeviceAvailable — routed to external")
            }
        case .oldDeviceUnavailable:
            // BT/wired device just dropped. Fall back to the call default.
            let isVideo = lockQueue.sync(execute: { hasVideo })
            let wantSpeaker = isVideo
            do {
                try session.overrideOutputAudioPort(wantSpeaker ? .speaker : .none)
                lockQueue.sync { self.speakerOn = wantSpeaker }
                print("[AudioRouter] oldDeviceUnavailable — fallback to \(wantSpeaker ? "speaker" : "earpiece")")
            } catch {
                print("[AudioRouter] route fallback failed: \(error)")
            }
        case .categoryChange, .override, .routeConfigurationChange:
            // No-op — usually self-induced or harmless reshuffles.
            break
        case .wakeFromSleep, .noSuitableRouteForCategory, .unknown:
            break
        @unknown default:
            break
        }
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
}
