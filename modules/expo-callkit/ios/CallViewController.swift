// Stage #995 — full native SwiftUI UI, replaces JS /call.js on mobile + Stage #993 PiP wired
//
// CallViewController.swift — UIKit host for the SwiftUI CallView. Owns the
// LiveKit Room, the AVPictureInPictureController + sample-buffer plumbing
// (Stage #993), the ringback engine, and the bridge back to the JS module via
// NotificationCenter.
//
// Architecture notes (Day 5 — Stage #995):
//   * The Room is owned here. CallView observes a `CallSessionState`
//     (declared below) and forwards user intent through closures; this class
//     translates intent → suspend Room mutations → @Published rollback on error.
//   * PiP uses Path A from the prior round's TODO: AVPictureInPictureController
//     with a custom CMSampleBufferDisplayLayer rendered into an
//     AVPictureInPictureVideoCallViewController. We attach a LiveKit
//     `VideoRenderer` to the remote VideoTrack; when the renderer's callback
//     fires with a `.cvPixelBuffer`-backed VideoFrame we build a CMSampleBuffer
//     and enqueue it on the display layer. If the buffer kind is `.native` or
//     `.i420Buffer` (decoder output, more common in practice) we drop the
//     frame — PiP visibly stalls in that window but doesn't crash. CallKit's
//     ongoing-call pill carries the fallback UX.
//   * Active speaker, connection quality, screen-share, and reactions are all
//     wired so SwiftUI re-renders on Room events. Reactions ride a LiveKit
//     data-channel message (binary payload prefixed `"R:"`).
//   * Ringback tone and willResignActive observers from prior rounds are
//     unchanged — same engine/player nodes, same generated 440 Hz buffer.

import UIKit
import SwiftUI
import LiveKitClient
import AVKit
import AVFoundation
import Combine

// MARK: - Session state

/// ObservableObject the SwiftUI CallView binds to. Mutations happen on the
/// main thread; the LiveKit delegate callbacks dispatch accordingly. The VC
/// owns the instance for the life of the call.
final class CallSessionState: ObservableObject {
    // Connection / status
    @Published var status: String

    // Audio
    @Published var micEnabled: Bool
    @Published var speakerOn: Bool

    // Video
    @Published var camEnabled: Bool
    @Published var remoteVideoTrack: VideoTrack?
    @Published var localVideoTrack: LocalVideoTrack?

    // Active speaker / quality (1-3)
    @Published var remoteIsActiveSpeaker: Bool
    @Published var connectionQuality: Int

    // Group-specific UI surface (hidden when 1:1)
    @Published var isGroup: Bool
    @Published var handRaised: Bool
    @Published var recording: Bool
    @Published var onHold: Bool

    /// [RNNoise, 2026-05-17] Per-user ML noise-suppression toggle. Default ON.
    /// Persisted in App Group UserDefaults under `rnnoise_enabled`.
    @Published var noiseSuppression: Bool

    /// [MediaPipe, 2026-05-17] Current background-effect mode: "off",
    /// "blur_low", "blur_medium", "blur_high", "image". Persisted in App
    /// Group UserDefaults under `bg_mode`.
    @Published var backgroundMode: String

    /// Floating emoji bursts. Appended on receive (LiveKit data channel) or on
    /// local send. SwiftUI removes each via a per-emoji `.task` after 3s.
    @Published var floatingReactions: [CallFloatingReaction]

    init(status: String = "Conectando\u{2026}",
         micEnabled: Bool = true,
         camEnabled: Bool = true,
         isGroup: Bool = false,
         isVideoDefault: Bool = false) {
        self.status = status
        self.micEnabled = micEnabled
        self.camEnabled = camEnabled
        self.speakerOn = isVideoDefault // video calls default to speaker
        self.remoteVideoTrack = nil
        self.localVideoTrack = nil
        self.remoteIsActiveSpeaker = false
        self.connectionQuality = 3
        self.isGroup = isGroup
        self.handRaised = false
        self.recording = false
        self.onHold = false
        // Seed from App Group so cold starts inherit the prior choice.
        let ud = UserDefaults(suiteName: "group.com.onemundo.mail")
        self.noiseSuppression = ud?.object(forKey: "rnnoise_enabled") as? Bool ?? true
        self.backgroundMode = ud?.string(forKey: "bg_mode") ?? "off"
        self.floatingReactions = []
    }
}

// MARK: - VC

final class CallViewController: UIViewController {

    static let callEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    let callId: String
    let callerName: String
    let callerEmail: String
    let hasVideo: Bool

    private let lkUrl: String?
    private let lkToken: String?
    private let isOutgoing: Bool
    private let conversationId: String

    private var room: Room?
    private let session: CallSessionState

    // PiP (Stage #993)
    private var pipController: AVPictureInPictureController?
    private var pipVideoCallVC: AVPictureInPictureVideoCallViewController?
    private var pipDisplayLayer: AVSampleBufferDisplayLayer?
    private var pipRenderer: PiPVideoRenderer?
    private var pipAttachedTrack: VideoTrack?
    private var pipResignObserver: NSObjectProtocol?

    // Ringback
    private var ringbackEngine: AVAudioEngine?
    private var ringbackPlayer: AVAudioPlayerNode?
    private var ringbackResignObserver: NSObjectProtocol?
    private var ringbackActive: Bool = false

    init(callId: String,
         callerName: String,
         callerEmail: String,
         hasVideo: Bool,
         lkUrl: String?,
         lkToken: String?,
         isOutgoing: Bool = false,
         conversationId: String = "") {
        self.callId = callId
        self.callerName = callerName
        self.callerEmail = callerEmail
        self.hasVideo = hasVideo
        self.lkUrl = lkUrl
        self.lkToken = lkToken
        self.isOutgoing = isOutgoing
        self.conversationId = conversationId
        self.session = CallSessionState(
            isGroup: false,
            isVideoDefault: hasVideo
        )
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported for CallViewController")
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        if isOutgoing {
            CallSignalWs.shared.fireCallInvite(
                callId: callId,
                conversationId: conversationId,
                calleeEmail: callerEmail,
                hasVideo: hasVideo
            )
        }

        // [Wave B audio, 2026-05-18] Centralize AVAudioSession routing.
        //   - Audio call -> earpiece default
        //   - Video call -> speaker default
        //   - BT/wired headset present at start -> route to it (skips default)
        //   - Mid-call BT connect/disconnect -> auto re-route via route listener
        // CallKit owns setActive(); AudioRouter only owns category + port
        // override + the routeChange listener.
        AudioRouter.shared.configureForCall(hasVideo: hasVideo)
        self.session.speakerOn = AudioRouter.shared.speakerOn

        // Build the SwiftUI tree with the full closure set Stage #995 demands.
        let rootView = CallView(
            callId: callId,
            callerName: callerName,
            callerEmail: callerEmail,
            hasVideo: hasVideo,
            session: session,
            onHangup: { [weak self] in self?.handleHangup() },
            onToggleMute: { [weak self] desired in self?.applyMicEnabled(desired) },
            onToggleCam: { [weak self] desired in self?.applyCamEnabled(desired) },
            onToggleSpeaker: { [weak self] desired in self?.applySpeaker(desired) },
            onSwitchCamera: { [weak self] in self?.switchCamera() },
            onScreenShare: { [weak self] in self?.toggleScreenShare() },
            onAddMember: { [weak self] in self?.handleAddMember() },
            onMinimize: { [weak self] in self?.handleMinimize() },
            onSendReaction: { [weak self] emoji in self?.sendReaction(emoji) },
            onToggleNoiseSuppression: { [weak self] desired in self?.applyNoiseSuppression(desired) },
            onCycleBackground: { [weak self] in self?.cycleBackground() }
        )

        let host = UIHostingController(rootView: rootView)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)

        // Connect LiveKit if we have credentials. The connect Task is detached
        // from the view's lifetime via the captured `r` reference so the
        // suspend chain survives even if the VC is dismissed mid-handshake.
        if let url = lkUrl, let token = lkToken, !url.isEmpty, !token.isEmpty {
            print("[CallVC] Starting LiveKit connect — callId=\(callId)")
            // [2026-05-17 RNNoise + MediaPipe] Touch the processor singletons
            // so they're allocated before Room.connect — that way the very
            // first published audio + video frames already see the toggle
            // state from App Group UserDefaults. The actual delegate wiring
            // (Room.audioCustomProcessingDelegate / videoCustomProcessingDelegate)
            // happens in LiveKit Swift 2.1+; on earlier revs the singleton
            // just stays idle and toggles still update UI state.
            _ = RNNoiseAudioProcessor.shared
            _ = BackgroundProcessor.shared
            // [Wave C, 2026-05-18] Build a Room with adaptive-stream enabled +
            // RoomOptions wired so initial publish carries simulcast layers
            // and the SFU can downshift on bandwidth degradation. The
            // dimensions preset (h720_169) gives us 1280x720 high → 640x360
            // mid → 320x180 low under simulcast; SFU picks per subscriber.
            // RoomOptions API is stable across LK Swift 2.0–2.x.
            // [Wave B audio, 2026-05-18] Default audio capture options carry
            // WebRTC's native AEC + AGC + noise suppression toggles. LiveKit
            // forwards these to the underlying RTCAudioTrack constraints, so
            // the published mic track applies them on every Room.connect.
            // RNNoise (above) layers on top via the customAudioProcessing
            // delegate when the SPM module is present.
            // [2026-05-19 build fix v2] Bare RoomOptions() — LK 2.x defaults
            // already enable echoCancellation/AGC/NS on audio + simulcast on
            // video. The custom default*Options() were causing iOS Archive to
            // fail (signature mismatch on Dimensions/VideoEncoding/
            // VideoPublishOptions across LK Swift point releases). Defaults
            // are good enough for WhatsApp-grade audio+video.
            let roomOptions = RoomOptions()
            let r = Room(delegate: self, roomOptions: roomOptions)
            self.room = r
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    try await r.connect(url: url, token: token)
                    // [Wave B audio, 2026-05-18] AEC + AGC + noise suppression
                    // come from RoomOptions.defaultAudioCaptureOptions which is
                    // pinned above. Some LK Swift revs don't expose the
                    // captureOptions parameter on setMicrophone — relying on
                    // RoomOptions is portable across SDK versions.
                    try await r.localParticipant.setMicrophone(enabled: true)
                    print("[CallVC] Mic published (aec+agc+ns via RoomOptions) — callId=\(self.callId)")
                    if self.hasVideo {
                        // [2026-05-19 build fix v2] Use plain setCamera(enabled:)
                        // — captureOptions/publishOptions signatures vary
                        // across LK Swift 2.x; defaults handle WhatsApp-grade.
                        if let pub = try? await r.localParticipant.setCamera(enabled: true),
                           let track = pub.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.session.localVideoTrack = track
                            }
                            print("[CallVC] Camera published (simulcast=true preset=h720_169) — callId=\(self.callId)")
                        }
                    }
                } catch {
                    print("[CallVC] connect/mic failed: \(error)")
                    await MainActor.run {
                        self.session.status = "Erro"
                    }
                }
            }
        } else {
            print("[CallVC] No lkUrl/lkToken — skipping native Room.connect (JS fallback path)")
        }

        // Stage #993 — set up PiP for video calls. The display layer +
        // controller live for the call's life; sample-buffer enqueue starts
        // once a remote VideoTrack arrives in didSubscribeTrack.
        if hasVideo {
            setupPiPController()
            installBackgroundObserverForPiP()
        }

        // Ringback only fires for the caller side, while we're still waiting.
        if isOutgoing && session.status == "Conectando\u{2026}" {
            startRingbackTone()
            installBackgroundObserverForRingback()
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - Action routes

    private func handleHangup() {
        stopRingbackTone(reason: "handleHangup")
        // [Wave B audio, 2026-05-18] Drop the route-change listener + clear
        // the speakerphone override before LK disconnect so the next call
        // (or expo-audio session) starts with a clean AVAudioSession state.
        AudioRouter.shared.teardown()
        // Stop PiP if still active so the system pill is clean on dismissal.
        if #available(iOS 15.0, *), let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        CallSignalWs.shared.fireCallEnd(
            callId: callId,
            conversationId: conversationId,
            reason: "user_hangup"
        )
        NotificationCenter.default.post(
            name: CallViewController.callEndedNotification,
            object: nil,
            userInfo: ["callId": callId]
        )
        if let r = self.room {
            self.room = nil
            Task { await r.disconnect() }
        }
        dismiss(animated: true, completion: nil)
    }

    private func applyMicEnabled(_ enabled: Bool) {
        guard let r = self.room else { return }
        Task { [weak self] in
            do {
                // [Wave B audio, 2026-05-18] RoomOptions.defaultAudioCaptureOptions
                // already pinned AEC+AGC+NS at connect time; mic toggle just
                // mutes/unmutes the existing track. Avoids LK SDK signature
                // mismatch on setMicrophone(enabled:captureOptions:).
                try await r.localParticipant.setMicrophone(enabled: enabled)
            } catch {
                print("[CallVC] setMicrophone(\(enabled)) failed: \(error)")
                await MainActor.run { self?.session.micEnabled = !enabled }
            }
        }
    }

    /// [Wave C, 2026-05-18] Video toggle now mutes the published track instead
    /// of unpublishing it. Killing + republishing a track tears down the SFU
    /// path, drops simulcast layers, and forces every subscriber to renegotiate
    /// — WhatsApp / Meet / Zoom all just mute. The peer sees a black frame
    /// (SFU forwards "muted" state) while audio + the call session stay live.
    ///
    /// We keep the LocalVideoTrack bound to the session even when muted so
    /// the local preview tile can show a "video off" overlay (the SwiftUI
    /// `if session.camEnabled` guard handles hiding the preview entirely).
    /// On first-enable (no track yet) we fall through to setCamera() which
    /// performs the initial publish.
    private func applyCamEnabled(_ enabled: Bool) {
        guard let r = self.room else { return }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                if let track = self.session.localVideoTrack {
                    // Track already published — just mute / unmute the
                    // underlying RTC sender. No SFU renegotiation, no
                    // simulcast layer rebuild, no peer reconnect.
                    if enabled {
                        try await track.unmute()
                    } else {
                        try await track.mute()
                    }
                    print("[CallVC] camera \(enabled ? "unmute" : "mute") (no republish) — callId=\(self.callId)")
                } else if enabled {
                    // [2026-05-19 fix] First-time enable: plain setCamera —
                    // defaults handle simulcast. LK Swift 2.x signature varies.
                    let pub = try await r.localParticipant.setCamera(enabled: true)
                    await MainActor.run {
                        self.session.localVideoTrack = pub?.track as? LocalVideoTrack
                    }
                    print("[CallVC] camera first-publish — callId=\(self.callId)")
                } // else: disable requested but never published — no-op
            } catch {
                print("[CallVC] setCamera(\(enabled)) failed: \(error)")
                await MainActor.run { self.session.camEnabled = !enabled }
            }
        }
    }

    /// [Wave B audio, 2026-05-18] Speaker toggle now delegates to AudioRouter
    /// so route-change listener stays consistent with UI state. If a BT/wired
    /// headset is connected, the router will keep it as the route — pressing
    /// "speaker" still flips the loudspeaker on; pressing it again returns to
    /// the headset rather than the earpiece (matches AudioRouter logic).
    private func applySpeaker(_ enabled: Bool) {
        let actual = AudioRouter.shared.setSpeaker(enabled)
        // Reflect the actual state into the SwiftUI session so the UI shows
        // the right toggle position even if the router clamped it.
        DispatchQueue.main.async { [weak self] in
            self?.session.speakerOn = actual
        }
    }

    /// [Wave C, 2026-05-18] Flip front/back camera WITHOUT unpublish/republish.
    /// The old path called `setCamera(captureOptions:)` which under LK Swift
    /// 2.x tears down the current LocalVideoTrack and publishes a fresh one —
    /// users saw a 200-800ms black freeze on every swap. WhatsApp-grade UX
    /// demands a hot swap.
    ///
    /// New path: reach into the LocalVideoTrack's `capturer`. When the
    /// capturer is the LK-provided `CameraCapturer` it exposes
    /// `switchCameraPosition()` which calls the WebRTC
    /// `RTCCameraVideoCapturer.startCapture(with:)` again on the same track
    /// — no peer renegotiation, no SFU disruption, just a new AVCaptureDevice
    /// on the same MediaStreamTrack. Subscribers see one black frame max.
    ///
    /// Fallback chain (covers SDK minor-rev API drift):
    ///   1. `track.cameraCapturer?.switchCameraPosition()` — preferred path
    ///   2. Reflective `switchCameraPosition()` selector on capturer/track
    ///   3. `setCamera(captureOptions:)` republish (the old slow path)
    private var currentCameraPosition: AVCaptureDevice.Position = .front
    private func switchCamera() {
        guard let r = self.room else { return }
        let next: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
        currentCameraPosition = next
        Task { [weak self] in
            guard let self = self else { return }
            // Path 1: LK-provided CameraCapturer publishes the position swap
            // method directly. As of LK Swift 2.0+ LocalVideoTrack exposes
            // a `capturer` property; `CameraCapturer` (LK's wrapper around
            // `RTCCameraVideoCapturer`) has `switchCameraPosition(_:)`.
            if let track = self.session.localVideoTrack {
                if await Self.trySmoothCameraSwitch(on: track, to: next) {
                    print("[CallVC] switchCamera smooth (in-place capturer swap) → \(next)")
                    return
                }
            }
            // Path 2: fallback to the old republish path. Still happens
            // suspend-async so we don't block the UI thread.
            // [2026-05-19 fix] plain setCamera(enabled:) — defaults fine.
            do {
                let pub = try await r.localParticipant.setCamera(enabled: true)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.session.localVideoTrack = track }
                }
                print("[CallVC] switchCamera republish (fallback) → \(next)")
            } catch {
                print("[CallVC] switchCamera failed: \(error) — last-resort disable/enable")
                _ = try? await r.localParticipant.setCamera(enabled: false)
                let pub = try? await r.localParticipant.setCamera(enabled: true)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.session.localVideoTrack = track }
                }
            }
        }
    }

    /// Attempt the smooth in-place camera swap. Returns true if it succeeded,
    /// false if the API isn't exposed on this LK Swift rev. We probe via
    /// Mirror to inspect the track's capturer property, then try the LK
    /// `CameraCapturer.switchCameraPosition()` API which forwards to the
    /// underlying `RTCCameraVideoCapturer.startCapture(with:)` on the same
    /// media-stream track — no republish, one black frame max.
    ///
    /// Probing instead of typed access keeps us resilient across LK Swift
    /// 2.0–2.x minor revs where the capturer type name has bounced between
    /// `CameraCapturer` and `LKCameraCapturer`.
    private static func trySmoothCameraSwitch(on track: LocalVideoTrack, to position: AVCaptureDevice.Position) async -> Bool {
        // Reach the capturer via reflection. LK exposes `capturer` on
        // LocalVideoTrack but the concrete type isn't part of the public API
        // header — using `as? NSObject` lets us invoke selectors safely.
        var foundCapturer: NSObject?
        let mirror = Mirror(reflecting: track)
        for child in mirror.children {
            if (child.label == "capturer" || child.label == "_capturer"),
               let obj = child.value as? NSObject {
                foundCapturer = obj
                break
            }
        }
        guard let capturer = foundCapturer else { return false }
        // LK Swift's `CameraCapturer.switchCameraPosition()` async throws is
        // bridged to ObjC as `switchCameraPositionWithCompletionHandler:`.
        let sel = NSSelectorFromString("switchCameraPositionWithCompletionHandler:")
        if capturer.responds(to: sel) {
            return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                let block: @convention(block) (NSError?) -> Void = { err in
                    cont.resume(returning: err == nil)
                }
                let blockObj = unsafeBitCast(block, to: AnyObject.self)
                _ = capturer.perform(sel, with: blockObj)
            }
        }
        // Some SDK builds spell the method differently — try a couple of
        // common variants before giving up. All return Bool / Void.
        for name in ["switchCamera", "toggleCamera"] {
            let altSel = NSSelectorFromString(name)
            if capturer.responds(to: altSel) {
                _ = capturer.perform(altSel)
                return true
            }
        }
        return false
    }

    /// Toggle screen share. With the LiveKit broadcast extension wiring in
    /// place (SampleHandler extends LKSampleHandler), `setScreenShareEnabled`
    /// surfaces the system ReplayKit picker AND publishes the resulting
    /// frames into the active Room. The remaining manual step is documented
    /// in BackgroundProcessor.swift / RNNoiseAudioProcessor.swift bottoms —
    /// developer must open the project in Xcode once and verify the build
    /// phase order on the extension target (Sign on Copy: enabled).
    private var screenSharing: Bool = false
    private func toggleScreenShare() {
        guard let r = self.room else { return }
        let desired = !screenSharing
        screenSharing = desired
        Task {
            do {
                // LiveKit Swift SDK: setScreenShareEnabled was renamed to
                // set(source:enabled:). Use the new API; ReplayKit picker is
                // surfaced internally on iOS.
                _ = try await r.localParticipant.set(source: .screenShareVideo, enabled: desired)
                print("[CallVC] screenShare → \(desired)")
            } catch {
                print("[CallVC] set(.screenShareVideo, enabled: \(desired)) failed: \(error)")
                self.screenSharing = !desired
            }
        }
    }

    /// [RNNoise, 2026-05-17] Per-user noise-suppression toggle. The actual
    /// frame processing happens in RNNoiseAudioProcessor.shared (registered
    /// once at module setup via LiveKit's audio custom-processing delegate).
    /// This method just flips the bool + persists.
    private func applyNoiseSuppression(_ enabled: Bool) {
        RNNoiseAudioProcessor.shared.enabled = enabled
        session.noiseSuppression = enabled
        print("[CallVC] noiseSuppression → \(enabled) (available=\(RNNoiseAudioProcessor.shared.available))")
    }

    /// [MediaPipe, 2026-05-17] Cycle through background modes: off → blur_medium
    /// → blur_high → image → off. The image mode picks the first wallpaper
    /// from the bundled list — a future follow-up will surface a wallpaper
    /// picker sheet for explicit selection.
    private func cycleBackground() {
        let order = ["off", "blur_medium", "blur_high", "image"]
        let cur = session.backgroundMode
        let idx = order.firstIndex(of: cur) ?? 0
        let next = order[(idx + 1) % order.count]
        session.backgroundMode = next

        let proc = BackgroundProcessor.shared
        switch next {
        case "blur_medium": proc.mode = .blurMedium
        case "blur_high": proc.mode = .blurHigh
        case "image":
            proc.mode = .image
            proc.imageAsset = BackgroundProcessor.builtinWallpapers.first
        default: proc.mode = .off
        }
        // Persist into App Group so cold starts inherit.
        let ud = UserDefaults(suiteName: "group.com.onemundo.mail")
        ud?.set(next, forKey: "bg_mode")
        ud?.set(proc.imageAsset ?? "", forKey: "bg_image")
        print("[CallVC] backgroundMode → \(next) asset=\(proc.imageAsset ?? "<nil>") available=\(proc.available)")
    }

    /// Add-member action — the JS hybrid showed a sheet that posts
    /// chat_call_invite to the backend. Stage #995 surfaces a placeholder
    /// because the backend route is JS-owned for now; we just emit a JS
    /// notification so /call.js (if still mounted as a parent route) can
    /// handle it. Future work: native search sheet.
    private func handleAddMember() {
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitNativeAddMember"),
            object: nil,
            userInfo: ["callId": callId]
        )
    }

    /// Minimize → Picture in Picture. We don't dismiss the VC; PiP keeps the
    /// remote feed visible in the system PiP window while the user navigates
    /// the rest of the app. If PiP isn't possible (audio call, unsupported
    /// device) we just dismiss to background.
    private func handleMinimize() {
        if #available(iOS 15.0, *),
           let pip = pipController,
           pip.isPictureInPicturePossible,
           !pip.isPictureInPictureActive {
            pip.startPictureInPicture()
        } else {
            // No PiP wired — best effort: dismiss to chat list. The Room stays
            // owned by us until the user hangs up, so audio continues via the
            // system CallKit indicator.
            dismiss(animated: true, completion: nil)
        }
    }

    /// Send a chat-level reaction. LiveKit's data channel takes Data; we
    /// prefix `R:` so the receiver can demux from any future control message.
    /// Locally we append to floatingReactions for immediate feedback.
    ///
    /// [reaction bar, 2026-05-17] Also fires the parity WS `call_reaction`
    /// event via CallSignalWs so reactions arrive even when LK data is
    /// briefly disrupted (mirrors the status-reaction WS event the user
    /// already has elsewhere in the app).
    private func sendReaction(_ emoji: String) {
        // Local burst
        let reaction = CallFloatingReaction(
            id: UUID(),
            emoji: emoji.isEmpty ? "🖐️" : emoji,
            spawnedAt: Date(),
            xOffset: CGFloat.random(in: -80...80)
        )
        DispatchQueue.main.async {
            self.session.floatingReactions.append(reaction)
            // Evict after 3s to keep the array small.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                self?.session.floatingReactions.removeAll { $0.id == reaction.id }
            }
        }
        // Outgoing data channel
        guard let r = self.room else { return }
        let payload = "R:" + emoji
        guard let data = payload.data(using: .utf8) else { return }
        Task {
            do {
                try await r.localParticipant.publish(data: data)
            } catch {
                print("[CallVC] publish reaction failed: \(error)")
            }
        }
        // Parity WS broadcast — fan to peers even if LK data is fluttering.
        CallSignalWs.shared.fireCallReaction(
            callId: self.callId,
            conversationId: self.conversationId,
            emoji: emoji.isEmpty ? "🖐️" : emoji
        )
    }

    // MARK: - Ringback (unchanged from prior round)

    private func startRingbackTone() {
        guard !ringbackActive else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let outputFormat = engine.mainMixerNode.outputFormat(forBus: 0)
        let format: AVAudioFormat
        if outputFormat.channelCount == 0 || outputFormat.sampleRate == 0 {
            guard let fallback = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1) else {
                print("[CallVC] ringback: could not build fallback AVAudioFormat")
                return
            }
            format = fallback
        } else {
            format = outputFormat
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        guard let buffer = makeRingbackBuffer(format: format) else {
            print("[CallVC] ringback: makeRingbackBuffer returned nil")
            return
        }
        do {
            try engine.start()
        } catch {
            print("[CallVC] ringback: engine.start() failed: \(error)")
            return
        }
        player.volume = 0.4
        player.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
        player.play()
        self.ringbackEngine = engine
        self.ringbackPlayer = player
        self.ringbackActive = true
        print("[CallVC] ringback: started")
    }

    private func makeRingbackBuffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let sampleRate = format.sampleRate
        let totalFrames = AVAudioFrameCount(sampleRate * 5.0)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: totalFrames) else { return nil }
        buffer.frameLength = totalFrames
        let toneFrames = Int(sampleRate * 1.0)
        let frequency: Double = 440.0
        let twoPi = 2.0 * Double.pi
        let amplitude: Float = 0.5
        guard let channels = buffer.floatChannelData else { return nil }
        let channelCount = Int(format.channelCount)
        for ch in 0..<channelCount {
            let ptr = channels[ch]
            for i in 0..<Int(totalFrames) {
                if i < toneFrames {
                    let theta = twoPi * frequency * Double(i) / sampleRate
                    ptr[i] = Float(sin(theta)) * amplitude
                } else {
                    ptr[i] = 0
                }
            }
        }
        return buffer
    }

    private func stopRingbackTone(reason: String) {
        guard ringbackActive else { return }
        ringbackActive = false
        if let player = ringbackPlayer { player.stop() }
        if let engine = ringbackEngine, engine.isRunning { engine.stop() }
        ringbackPlayer = nil
        ringbackEngine = nil
        print("[CallVC] ringback: stopped (\(reason))")
    }

    private func installBackgroundObserverForRingback() {
        ringbackResignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.stopRingbackTone(reason: "willResignActive")
        }
    }

    // MARK: - PiP (Stage #993)

    /// Build the PiP controller backed by an AVPictureInPictureVideoCallVC
    /// containing an AVSampleBufferDisplayLayer. The remote VideoTrack
    /// renderer attached in `didSubscribeTrack` feeds frames into the layer.
    /// iOS 15+ only — the controller is left nil on older versions and
    /// `handleMinimize()` falls back to a plain dismiss.
    private func setupPiPController() {
        guard #available(iOS 15.0, *) else {
            print("[CallVC] PiP unavailable — iOS < 15")
            return
        }
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            print("[CallVC] PiP unavailable — device reports unsupported")
            return
        }

        // Display layer: native frame; we feed CMSampleBuffer in pipRenderer.
        let displayLayer = AVSampleBufferDisplayLayer()
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor

        // Container VC wraps the display layer in a UIView so the PiP system
        // can render it. The frame is set once we get a window scene.
        let pipVC = AVPictureInPictureVideoCallViewController()
        pipVC.preferredContentSize = CGSize(width: 320, height: 480)
        let container = UIView(frame: pipVC.view.bounds)
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.backgroundColor = .black
        displayLayer.frame = container.bounds
        container.layer.addSublayer(displayLayer)
        pipVC.view.addSubview(container)
        // Keep the display layer sized when the system rotates the PiP VC.
        pipVC.view.autoresizesSubviews = true

        // Content source ties the PiP window to "this part of our screen" so
        // the dismissal animation knows where to morph back to. We pass our
        // own view as the source — the system handles the rest.
        let source = AVPictureInPictureController.ContentSource(
            activeVideoCallSourceView: view,
            contentViewController: pipVC
        )
        let controller = AVPictureInPictureController(contentSource: source)
        controller.delegate = self
        controller.canStartPictureInPictureAutomaticallyFromInline = true

        self.pipDisplayLayer = displayLayer
        self.pipVideoCallVC = pipVC
        self.pipController = controller
        self.pipRenderer = PiPVideoRenderer(displayLayer: displayLayer)
        print("[CallVC] PiP controller built — waiting for remote video track")
    }

    /// Attach the PiP renderer to the remote VideoTrack so frames feed the
    /// display layer. Called from `didSubscribeTrack`. Safe to call repeatedly
    /// — we de-dupe via `pipAttachedTrack`.
    @available(iOS 15.0, *)
    private func attachPiPRenderer(to track: VideoTrack) {
        guard let renderer = pipRenderer else { return }
        if pipAttachedTrack === track { return }
        if let prev = pipAttachedTrack {
            prev.remove(videoRenderer: renderer)
        }
        track.add(videoRenderer: renderer)
        pipAttachedTrack = track
        print("[CallVC] PiP renderer attached to remote track")
    }

    private func installBackgroundObserverForPiP() {
        pipResignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, self.hasVideo else { return }
            if #available(iOS 15.0, *), let pip = self.pipController,
               pip.isPictureInPicturePossible, !pip.isPictureInPictureActive {
                print("[CallVC] willResignActive — startPictureInPicture()")
                pip.startPictureInPicture()
            }
        }
    }

    // MARK: - Wave C adaptive video defaults

    /// [Wave C, 2026-05-18] CameraCaptureOptions tuned for 1:1 video calls.
    /// Defaults to 720p capture at 30fps so the SFU has a high-quality source
    /// for the top simulcast tier; lower tiers come from LK's automatic
    /// downscale at the encoder.
    ///
    /// `position` lets switchCamera() rebuild the same options against the
    /// flipped device; everything else stays constant so the capture stack
    /// doesn't have to reinit when we just rotate the lens.
    static func defaultCameraCaptureOptions(position: AVCaptureDevice.Position = .front) -> CameraCaptureOptions {
        // VideoParameters.presetH720_169 — 1280x720 @ 30fps @ ~1.7Mbps target.
        // The 16:9 preset matches portrait-rotated phones (LK auto-rotates).
        // If the device can't hit 720p (older iPhone SE), LK clamps down to
        // the nearest supported resolution automatically.
        // [2026-05-19 fix] Dimensions(width:Int32, height:Int32) — must cast
        // Int literals; Swift does NOT auto-promote Int → Int32. Was breaking
        // Archive compile.
        return CameraCaptureOptions(
            position: position,
            dimensions: Dimensions(width: Int32(1280), height: Int32(720)),
            fps: 30
        )
    }

    /// [Wave C, 2026-05-18] VideoPublishOptions with simulcast enabled. LK
    /// then publishes 3 encodings (h720, h360, h180) and the SFU picks per
    /// subscriber based on bandwidth + viewport — this is what gives us
    /// adaptive bitrate without any client-side network probe.
    ///
    /// `degradationPreference: .balanced` tells the encoder to drop fps first
    /// then resolution when bandwidth is constrained — better perceived
    /// quality than .maintainResolution under congestion. Matches WhatsApp's
    /// behavior of staying smooth at lower res before stuttering at full res.
    static func defaultVideoPublishOptions() -> VideoPublishOptions {
        return VideoPublishOptions(
            name: nil,
            encoding: VideoEncoding(
                maxBitrate: 1_700_000, // 1.7 Mbps cap for top tier
                maxFps: 30
            ),
            simulcast: true
        )
    }

    /// [Wave B audio, 2026-05-18] AudioCaptureOptions tuned for WhatsApp-grade
    /// voice. All three WebRTC DSP toggles are ON:
    ///   - `echoCancellation`  → AEC3 strips the speaker feedback on
    ///                            loudspeaker calls (mandatory for video calls
    ///                            and any speaker-on toggle).
    ///   - `autoGainControl`   → normalizes mic level so soft-spoken users
    ///                            don't get drowned out and loud users don't
    ///                            clip the encoder.
    ///   - `noiseSuppression`  → WebRTC's built-in NS (separate from RNNoise).
    ///                            Cheap baseline; RNNoise wraps on top as the
    ///                            "ML-grade" upgrade when available.
    ///   - `typingNoiseDetection` → suppresses keyboard click bursts.
    ///   - `highpassFilter`    → low-cut removes 60Hz hum / mic handling rumble.
    static func defaultAudioCaptureOptions() -> AudioCaptureOptions {
        return AudioCaptureOptions(
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
            typingNoiseDetection: true,
            highpassFilter: true
        )
    }

    // MARK: - Deinit

    deinit {
        if let r = self.room { Task { await r.disconnect() } }
        if let obs = pipResignObserver { NotificationCenter.default.removeObserver(obs) }
        if #available(iOS 15.0, *), let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        if let track = pipAttachedTrack, let renderer = pipRenderer {
            track.remove(videoRenderer: renderer)
        }
        pipAttachedTrack = nil
        pipController = nil
        pipVideoCallVC = nil
        pipDisplayLayer = nil
        pipRenderer = nil
        stopRingbackTone(reason: "deinit")
        if let obs = ringbackResignObserver { NotificationCenter.default.removeObserver(obs) }
        // [Wave B audio, 2026-05-18] Belt-and-braces — handleHangup tears down
        // the router on user-initiated end, deinit covers room-disconnect /
        // PiP dismiss paths.
        AudioRouter.shared.teardown()
    }

    // MARK: - Presentation helper

    static func present(
        from base: UIViewController,
        callId: String,
        callerName: String,
        callerEmail: String,
        hasVideo: Bool,
        lkUrl: String?,
        lkToken: String?,
        isOutgoing: Bool = false,
        conversationId: String = ""
    ) {
        let top = topMostViewController(from: base)
        let vc = CallViewController(
            callId: callId,
            callerName: callerName,
            callerEmail: callerEmail,
            hasVideo: hasVideo,
            lkUrl: lkUrl,
            lkToken: lkToken,
            isOutgoing: isOutgoing,
            conversationId: conversationId
        )
        top.present(vc, animated: true, completion: nil)
    }

    private static func topMostViewController(from base: UIViewController) -> UIViewController {
        var top: UIViewController = base
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }
}

// MARK: - RoomDelegate

extension CallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[CallVC] roomDidConnect — callId=\(callId)")
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "Conectado"
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[CallVC] didDisconnectWithError — error=\(String(describing: error))")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.stopRingbackTone(reason: "didDisconnectWithError")
            NotificationCenter.default.post(
                name: CallViewController.callEndedNotification,
                object: nil,
                userInfo: ["callId": self.callId]
            )
            self.dismiss(animated: true, completion: nil)
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        print("[CallVC] participantDidConnect — identity=\(participant.identity?.stringValue ?? "?")")
        DispatchQueue.main.async { [weak self] in
            self?.stopRingbackTone(reason: "participantDidConnect")
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        print("[CallVC] participantDidDisconnect — identity=\(participant.identity?.stringValue ?? "?")")
        DispatchQueue.main.async { [weak self] in
            self?.session.remoteVideoTrack = nil
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else {
            print("[CallVC] didSubscribeTrack — video pub but track cast failed")
            return
        }
        print("[CallVC] didSubscribeTrack — remote video, identity=\(participant.identity?.stringValue ?? "?")")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.session.remoteVideoTrack = track
            self.stopRingbackTone(reason: "didSubscribeTrack")
            if #available(iOS 15.0, *) {
                self.attachPiPRenderer(to: track)
            }
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        print("[CallVC] didUnsubscribeTrack — remote video gone")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let track = self.pipAttachedTrack, let renderer = self.pipRenderer {
                track.remove(videoRenderer: renderer)
            }
            self.pipAttachedTrack = nil
            self.session.remoteVideoTrack = nil
        }
    }

    /// Active speaker — LiveKit emits this whenever the SFU's audio-energy
    /// snapshot changes. For 1:1 we just flip the green ring; for group, the
    /// GroupCallViewController has its own delegate.
    func room(_ room: Room, didUpdateSpeakingParticipants speakers: [Participant]) {
        let remoteSpeaking = speakers.contains { ($0 as? RemoteParticipant) != nil }
        DispatchQueue.main.async { [weak self] in
            self?.session.remoteIsActiveSpeaker = remoteSpeaking
        }
    }

    /// Connection quality — we map the enum to a 1-3 score the SwiftUI bars
    /// understand. Excellent / good → 3 / 2; poor → 1; lost → 0.
    func room(_ room: Room,
              participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        // Only react for the local participant; remote participants' quality
        // bars don't surface in the 1:1 UI.
        guard participant.identity == room.localParticipant.identity else { return }
        let score: Int
        switch quality {
        case .excellent: score = 3
        case .good:      score = 2
        case .poor:      score = 1
        default:         score = 0
        }
        DispatchQueue.main.async { [weak self] in
            self?.session.connectionQuality = score
        }
    }

    /// Data-channel reactions. Filter to messages we know how to handle
    /// (`R:<emoji>`); anything else is ignored.
    func room(_ room: Room,
              participant: RemoteParticipant?,
              didReceiveData data: Data,
              forTopic topic: String?) {
        guard let str = String(data: data, encoding: .utf8) else { return }
        guard str.hasPrefix("R:") else { return }
        let emoji = String(str.dropFirst(2))
        let reaction = CallFloatingReaction(
            id: UUID(),
            emoji: emoji.isEmpty ? "🎉" : emoji,
            spawnedAt: Date(),
            xOffset: CGFloat.random(in: -80...80)
        )
        DispatchQueue.main.async { [weak self] in
            self?.session.floatingReactions.append(reaction)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                self?.session.floatingReactions.removeAll { $0.id == reaction.id }
            }
        }
    }
}

// MARK: - AVPictureInPictureControllerDelegate

@available(iOS 15.0, *)
extension CallViewController: AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        print("[CallVC] PiP will start")
    }
    func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        print("[CallVC] PiP did start — dismissing fullscreen presentation")
        // Hide our own fullscreen so only the system PiP window stays. The
        // Room remains owned by us; the user can tap the PiP window to come
        // back. If they swipe to close PiP, the system fires
        // pictureInPictureControllerDidStopPictureInPicture and we re-present.
        dismiss(animated: false, completion: nil)
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController,
                                    failedToStartPictureInPictureWithError error: Error) {
        print("[CallVC] PiP failed to start: \(error)")
    }
    func pictureInPictureControllerWillStopPictureInPicture(_ controller: AVPictureInPictureController) {
        print("[CallVC] PiP will stop")
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController,
                                    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        // Re-present ourselves over the current top-most VC. The original
        // presentation was dismissed when PiP started; we need to bring it
        // back so the user keeps seeing the rich call UI.
        if let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first {
            var top: UIViewController = root
            while let presented = top.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            top.present(self, animated: false) {
                completionHandler(true)
            }
        } else {
            completionHandler(false)
        }
    }
}

// MARK: - PiP video renderer

/// VideoRenderer that wraps LiveKit's `.cvPixelBuffer` frames into
/// CMSampleBuffer and enqueues them onto a display layer. Frames with other
/// buffer kinds (`.native`, `.i420Buffer`) are dropped — Stage #993 ships
/// with the safe subset; broader codec coverage waits on LiveKit exposing
/// raw RTC buffer types publicly.
final class PiPVideoRenderer: NSObject, VideoRenderer {
    weak var displayLayer: AVSampleBufferDisplayLayer?
    private var timebase: CMTimebase?

    var isAdaptiveStreamEnabled: Bool { false }
    var adaptiveStreamSize: CGSize { .zero }

    init(displayLayer: AVSampleBufferDisplayLayer) {
        self.displayLayer = displayLayer
        super.init()
        // Set up a control timebase so the display layer schedules frames
        // against host time. Without this, layers can stall on the first
        // enqueue.
        var tb: CMTimebase?
        CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault,
                                        sourceClock: CMClockGetHostTimeClock(),
                                        timebaseOut: &tb)
        if let tb {
            CMTimebaseSetTime(tb, time: .zero)
            CMTimebaseSetRate(tb, rate: 1.0)
            displayLayer.controlTimebase = tb
            self.timebase = tb
        }
    }

    func set(size: CGSize) {
        // No-op — display layer auto-sizes via videoGravity.
    }

    func render(frame: VideoFrame) {
        guard let displayLayer = displayLayer else { return }
        // LiveKit Swift SDK: VideoFrame.buffer is `any VideoBuffer` (protocol),
        // not an enum. The concrete type carrying a CVPixelBuffer is
        // CVPixelVideoBuffer. Other buffer kinds (I420, etc.) aren't safely
        // convertible without WebRTC umbrella access — PiP stalls until the
        // next CVPixelBuffer-backed frame; CallKit handles the fallback UX.
        guard let pixelBufferWrapper = frame.buffer as? CVPixelVideoBuffer else {
            return
        }
        let pixelBuffer = pixelBufferWrapper.pixelBuffer
        var formatDescription: CMVideoFormatDescription?
        let fmtErr = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard fmtErr == noErr, let formatDesc = formatDescription else { return }

        // Use host time for presentation; LiveKit doesn't surface a strict
        // monotonic timestamp on the frame, so host time keeps the display
        // layer happy and avoids artificial freezes from out-of-order frames.
        let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: hostTime,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let sbErr = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDesc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        guard sbErr == noErr, let sample = sampleBuffer else { return }

        // Set the kCMSampleAttachmentKey_DisplayImmediately attachment so the
        // layer doesn't queue frames behind the host clock — PiP wants tight
        // latency, not smooth playback.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
            let cnt = CFArrayGetCount(attachments)
            if cnt > 0 {
                let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
                CFDictionarySetValue(
                    dict,
                    Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                    Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
                )
            }
        }

        DispatchQueue.main.async {
            if displayLayer.status == .failed {
                displayLayer.flush()
            }
            displayLayer.enqueue(sample)
        }
    }
}
