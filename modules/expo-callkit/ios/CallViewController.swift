import UIKit
import SwiftUI
import LiveKitClient
// [2026-05-16] AVKit for AVPictureInPictureController. Already linked via
// system framework (no podspec change needed).
import AVKit
// [2026-05-16] AVFoundation for AVAudioEngine + AVAudioPlayerNode +
// AVAudioPCMBuffer (ringback tone generator). AVKit imports AVFoundation
// internally but Swift modules don't always re-export it, so we import
// explicitly. Already listed under `s.frameworks` in the podspec.
import AVFoundation

// [native call screen, 2026-05-16] UIKit host for the SwiftUI CallView.
// Mirrors the Android CallActivity entrypoint: JS calls openNativeCall,
// the module looks up the keyWindow's root VC, and we present this
// full-screen over whatever modal stack happens to be on top.
//
// [Day 2, 2026-05-16] CallViewController is now the LiveKit Room owner.
// The SwiftUI CallView reads connection status + mic state via an
// @ObservedObject CallSessionState (declared below) and reports user-driven
// mute toggles back through `onToggleMute` so the suspend setMicrophone
// call lives on the VC side. Day 1 was state-less scaffolding; Day 2 wires
// audio without touching NativeCallRoom (which is still the JS-driven path).

/// ObservableObject the SwiftUI CallView binds to. The VC mutates these
/// fields whenever LiveKit reports state changes (delegate callbacks) or the
/// user toggles mute, and SwiftUI re-renders the status text + mute button.
/// Kept inside CallViewController.swift per the Day 2 spec (we don't add new
/// files; the type co-locates with its writer).
final class CallSessionState: ObservableObject {
    @Published var status: String
    @Published var micEnabled: Bool
    // [Day 3, 2026-05-16] Video state. `camEnabled` is the desired local
    // capture state (mirrors `micEnabled`). The two track refs are set as
    // LiveKit reports publish/subscribe events; SwiftUI swaps in
    // SwiftUIVideoView when they go non-nil.
    @Published var camEnabled: Bool
    @Published var remoteVideoTrack: VideoTrack?
    @Published var localVideoTrack: LocalVideoTrack?

    init(status: String = "Conectando\u{2026}",
         micEnabled: Bool = true,
         camEnabled: Bool = true) {
        self.status = status
        self.micEnabled = micEnabled
        self.camEnabled = camEnabled
        self.remoteVideoTrack = nil
        self.localVideoTrack = nil
    }
}

final class CallViewController: UIViewController {

    // Notification posted when the user hangs up via the native UI. The
    // module observes this in OnCreate and forwards it as onCallEnded to JS.
    static let callEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // Call descriptor — captured at present() time so the SwiftUI view can
    // initialize without doing any lookup of its own.
    let callId: String
    let callerName: String
    let callerEmail: String
    let hasVideo: Bool

    // [Day 2, 2026-05-16] LiveKit connect params. Optional because outgoing
    // calls fetch the token after dialing; the openNativeCall path passes
    // them through from JS. When nil, we render the SwiftUI shell but skip
    // Room.connect — the JS-side @livekit/react-native path still works as
    // a fallback for unmigrated callers.
    private let lkUrl: String?
    private let lkToken: String?

    // [2026-05-16 Stage 2 native WS signaling] Outgoing-call flag + chat
    // conversation id. Used to drive CallSignalWs.shared.fireCallInvite /
    // fireCallEnd directly from this VC so the call signaling path no
    // longer requires the JS bridge. Both default to safe values
    // (false / "") so existing callers compile clean — the iOS module's
    // openNativeCall path defaults to outgoing=false until JS is updated
    // to forward the flag. JS-side WS firing remains as fallback; server
    // dedupes by call_id.
    private let isOutgoing: Bool
    private let conversationId: String

    // The Room is created in viewDidLoad and torn down on hangup / deinit.
    // Held as `var` so we can release it explicitly during disconnect.
    private var room: Room?

    // Shared state object the SwiftUI CallView observes. Mutations MUST
    // happen on the main thread; the delegate callbacks below dispatch
    // accordingly.
    private let session = CallSessionState()

    // [2026-05-16] PiP scaffolding — INTENTIONALLY UNSHIPPED.
    //
    // AVPictureInPictureController for a video-call-style PiP requires a
    // CMSampleBuffer feed enqueued on an AVSampleBufferDisplayLayer, wrapped
    // in an AVPictureInPictureVideoCallViewController (iOS 15+). LiveKit
    // Swift SDK 2.x does NOT publicly expose CMSampleBuffer frames from
    // VideoTrack — the two candidate adapter paths each carry blocking
    // risk we can't verify without building on a Mac (no /ios/Pods here,
    // prebuild is gitignored):
    //
    //  PATH A — LiveKit's own `VideoRenderer` Swift protocol
    //    LiveKit 2.x exposes `VideoRenderer` (Sources/LiveKit/Protocols/
    //    VideoRenderer.swift) and `VideoTrack.add(videoRenderer:)`. The
    //    callback delivers `LiveKit.VideoFrame`, whose `.buffer` is a
    //    `LiveKit.VideoBuffer` enum (.native(RTCVideoFrameBuffer) /
    //    .i420Buffer / .cvPixelBuffer). Unwrapping `.cvPixelBuffer` is
    //    safe; the `.native` and `.i420Buffer` cases require accessing
    //    WebRTC types (RTCCVPixelBuffer / RTCI420Buffer) which LiveKit
    //    2.x does NOT re-export publicly. So Path A covers ONLY the case
    //    where the publisher uses a CVPixelBuffer-backed source — front
    //    camera capture on iOS does, but software-encoded remote frames
    //    after decode may not (decoder output buffer type is opaque).
    //    Result: would work on local preview, may NOT work on remote
    //    tile, which is what users actually want in PiP.
    //
    //  PATH B — WebRTC's `RTCVideoRenderer` protocol directly
    //    Requires `import WebRTC` at the top of this file. LiveKit 2.x
    //    links WebRTC-SDK transitively, BUT the umbrella header is not
    //    guaranteed to be Swift-visible (depends on the pod's
    //    `module.modulemap` — varies across LiveKitClient minor versions,
    //    and `static_framework = true` in our podspec further complicates
    //    module visibility). High risk of "No such module 'WebRTC'" at
    //    compile time. Also: VideoTrack does not have a public
    //    `addRenderer(RTCVideoRenderer)` in LiveKit Swift 2.x — only the
    //    internal `mediaTrack` (RTCVideoTrack) does, and access to it is
    //    `internal`, not `public`. Would require either a fork or
    //    @_spi/Mirror-based reflection (both fragile).
    //
    // Per the spec ("If you cannot find the exact LiveKit Swift 2.x
    // renderer-attach API name, prefer NOT shipping than shipping a
    // guess"), PiP stays inert in this round. The property + support
    // check + willResignActive observer are kept so the wiring is in one
    // place once we can verify the right API on-device.
    //
    // CallKit's native ongoing-call indicator (yellow pill in status bar)
    // continues to keep the call discoverable while the app is
    // backgrounded — PiP is polish, not a must.
    //
    // TODO(iOS PiP, next steps):
    //   1. Build the app once locally on Mac with LiveKitClient ~> 2.0
    //      installed; run `nm` / `swift-symbolgraph-extract` against
    //      LiveKitClient.framework to confirm whether
    //      `VideoTrack.add(videoRenderer:)` is `public` in our pinned
    //      version.
    //   2. If yes: implement Path A, restrict PiP enable to calls where
    //      the first remote frame arrived with `.cvPixelBuffer` (and
    //      gracefully fall back if subsequent frames change buffer kind).
    //   3. If no / if `.cvPixelBuffer` rate is low in practice: revisit
    //      Path B once the Pods module map is inspected on-device.
    //   4. Defer until after ReplayKit refactor (see MEMORY:
    //      replaykit_lk_refactor_pending) — same WebRTC framework
    //      visibility question blocks both.
    private var pipController: AVPictureInPictureController?
    private var pipResignObserver: NSObjectProtocol?

    // [2026-05-16] Ringback tone (Part 2 of iOS call polish round).
    //
    // Plays the classic "trim trim trim" tone caller-side from the
    // moment CallViewController is presented (outgoing path only) until
    // either:
    //   (a) the remote participant subscribes to a track / connects, or
    //   (b) roomDidConnect actually fires (callee picked up), or
    //   (c) the app backgrounds.
    //
    // Implementation note: `ringback.wav` is NOT bundled (the app ships
    // `assets/ringtone.wav` for incoming, no outgoing tone). So we
    // generate a 440Hz sine tone via AVAudioEngine + AVAudioPlayerNode +
    // a 5s PCM buffer with 1s of tone + 4s of silence, scheduled in a
    // loop. The engine attaches to the SHARED AVAudioSession that
    // CallKit already configured for the LiveKit Room (.playAndRecord /
    // .voiceChat) — we do NOT call setCategory ourselves; that would
    // race the Room's setup. AVAudioEngine respects whatever the active
    // session category is, and CallKit's voiceChat mode mixes our player
    // node output with WebRTC's RTPC output cleanly.
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
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        // Disable swipe-to-dismiss — the call should only end via the
        // explicit hangup button (matches Android CallActivity behavior).
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported for CallViewController")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        // [2026-05-16 Stage 2 native WS signaling] Fire call_invite from
        // native for outgoing calls as soon as the VC is loaded — BEFORE the
        // JS bundle settles the openNativeCall promise. CallSignalWs queues
        // if the WS isn't yet authed (Stage 1 plumbing); the server dedupes
        // by call_id, so this fire racing the JS-side services/api.js
        // call_invite is fine — whichever lands first wins, the other is a
        // no-op. Empty conversationId is tolerated (dialer flow).
        //
        // We use the new init param `isOutgoing` (NOT the legacy lkToken
        // heuristic below that gates ringback) so a future incoming-path
        // openNativeCall — which DOES pass an lkToken — does not
        // mistakenly fire a call_invite for a call the user is answering.
        if isOutgoing {
            CallSignalWs.shared.fireCallInvite(
                callId: callId,
                conversationId: conversationId,
                calleeEmail: callerEmail,
                hasVideo: hasVideo
            )
        }

        // Build the SwiftUI tree with the shared session state + a hangup
        // closure that dismisses self and broadcasts the end so
        // ExpoCallKitModule can re-emit it to JS, plus a mute-toggle closure
        // that runs the suspend setMicrophone call on the LiveKit room.
        let rootView = CallView(
            callId: callId,
            callerName: callerName,
            callerEmail: callerEmail,
            hasVideo: hasVideo,
            session: session,
            onHangup: { [weak self] in
                self?.handleHangup()
            },
            onToggleMute: { [weak self] desiredEnabled in
                self?.applyMicEnabled(desiredEnabled)
            },
            // [Day 3, 2026-05-16] Camera toggle closure — symmetrical with
            // onToggleMute. CallView flips session.camEnabled optimistically;
            // applyCamEnabled rolls back on throw.
            onToggleCam: { [weak self] desiredEnabled in
                self?.applyCamEnabled(desiredEnabled)
            }
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

        // [Day 2, 2026-05-16] Kick the LiveKit connect once the view tree is
        // installed. Both url+token must be present — outgoing-call paths
        // that haven't fetched the token yet stay on the JS @livekit/react-
        // native fallback. The Room is constructed with `delegate: self`
        // (Swift-only init; no Obj-C `add(delegate:)`).
        if let url = lkUrl, let token = lkToken, !url.isEmpty, !token.isEmpty {
            print("[CallVC] Starting LiveKit connect — callId=\(callId)")
            let r = Room(delegate: self)
            self.room = r
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    try await r.connect(url: url, token: token)
                    // setMicrophone is the verified API name on LiveKit
                    // Swift SDK 2.x (LocalParticipant.swift main branch):
                    //   func setMicrophone(enabled: Bool, ...) async throws
                    try await r.localParticipant.setMicrophone(enabled: true)
                    print("[CallVC] Mic published — callId=\(self.callId)")
                    // [Day 3, 2026-05-16] If this is a video call, also
                    // publish the camera. Same API family as setMicrophone:
                    //   func setCamera(enabled: Bool, ...) async throws
                    //     -> LocalTrackPublication?
                    // We cast the returned publication's `track` to
                    // LocalVideoTrack so the SwiftUI layer can render the
                    // local preview tile. If the cast fails (track field
                    // changes in a future SDK rev), we still publish — only
                    // the PiP preview is skipped.
                    if self.hasVideo {
                        if let pub = try? await r.localParticipant.setCamera(enabled: true),
                           let track = pub.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.session.localVideoTrack = track
                            }
                            print("[CallVC] Camera published — callId=\(self.callId)")
                        } else {
                            print("[CallVC] Camera publish returned nil pub/track — callId=\(self.callId)")
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

        // [2026-05-16] PiP scaffolding — only attempt for video calls on
        // iOS 15+ when the device reports support. See the long comment
        // on `pipController` above for why this currently no-ops.
        if hasVideo {
            setupPiPController()
            installBackgroundObserverForPiP()
        }

        // [2026-05-16] Ringback tone for OUTGOING calls. Heuristic from
        // the spec: lkToken is non-nil (we're driving the connect) AND
        // session.status is still the initial "Conectando…" string. The
        // incoming-call path arrives here only via CallKit answer →
        // openNativeCall AFTER the answer suspend resolved, by which
        // point we'd never want a caller-side ringback anyway.
        let isOutgoing = (lkToken != nil)
            && !(lkToken?.isEmpty ?? true)
            && session.status == "Conectando\u{2026}"
        if isOutgoing {
            startRingbackTone()
            installBackgroundObserverForRingback()
        }
    }

    // MARK: - Ringback tone (outgoing only)

    /// Start the generated 440Hz ringback loop. Idempotent — repeated
    /// calls are no-ops once `ringbackActive` is true. Failures (engine
    /// won't start, AVAudioSession in a bad state, etc.) are logged but
    /// non-fatal: the call still proceeds without audible ringback.
    private func startRingbackTone() {
        guard !ringbackActive else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        // Use the engine's default mainMixer output format so the player
        // node format matches the hardware. CallKit/LiveKit configured
        // the shared AVAudioSession to .playAndRecord + .voiceChat
        // already; we DO NOT touch the category here (the spec warns
        // explicitly against racing the Room's audio session setup).
        let outputFormat = engine.mainMixerNode.outputFormat(forBus: 0)
        // mainMixer may report a 0-channel format if the engine was
        // never started — fall back to a safe 44.1kHz mono Float32.
        let format: AVAudioFormat
        if outputFormat.channelCount == 0 || outputFormat.sampleRate == 0 {
            guard let fallback = AVAudioFormat(
                standardFormatWithSampleRate: 44100,
                channels: 1
            ) else {
                print("[CallVC] ringback: could not build fallback AVAudioFormat")
                return
            }
            format = fallback
        } else {
            format = outputFormat
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)

        // Build a single 5-second PCM buffer: 1s of 440Hz sine, then 4s
        // of silence. Loop it via scheduleBuffer(.loops) so the rhythm
        // is "tone-pause-tone-pause…" mimicking standard PSTN ringback.
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

        // Volume 0.4 matches the spec's wav-path setting. interrupts:
        // false because we explicitly want this to NOT interrupt the
        // LiveKit voice-chat audio (which hasn't started yet, but might
        // mid-ring if the SDK pre-warms).
        player.volume = 0.4
        player.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
        player.play()

        self.ringbackEngine = engine
        self.ringbackPlayer = player
        self.ringbackActive = true
        print("[CallVC] ringback: started (440Hz, 1s on / 4s off loop)")
    }

    /// Build a 5-second PCM buffer with 1s of 440Hz sine + 4s of silence.
    /// Returns nil if AVAudioPCMBuffer allocation fails (very rare —
    /// usually only when format is malformed).
    private func makeRingbackBuffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let sampleRate = format.sampleRate
        let totalFrames = AVAudioFrameCount(sampleRate * 5.0)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: totalFrames
        ) else {
            return nil
        }
        buffer.frameLength = totalFrames

        let toneFrames = Int(sampleRate * 1.0)
        let frequency: Double = 440.0
        let twoPi = 2.0 * Double.pi
        let amplitude: Float = 0.5 // pre-mix; player.volume scales further

        guard let channels = buffer.floatChannelData else {
            return nil
        }
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

    /// Stop the ringback engine + player. Idempotent — safe to call
    /// multiple times (roomDidConnect, first didSubscribeTrack, and
    /// applicationWillResignActive may all fire in sequence).
    private func stopRingbackTone(reason: String) {
        guard ringbackActive else { return }
        ringbackActive = false
        if let player = ringbackPlayer {
            player.stop()
        }
        if let engine = ringbackEngine, engine.isRunning {
            engine.stop()
        }
        ringbackPlayer = nil
        ringbackEngine = nil
        print("[CallVC] ringback: stopped (\(reason))")
    }

    /// Stop ringback if the app backgrounds before the callee picks up.
    /// CallKit's audio session keeps the Room mic open, but the player
    /// node would otherwise keep buzzing in the background, which is
    /// jarring and wastes battery.
    private func installBackgroundObserverForRingback() {
        let center = NotificationCenter.default
        ringbackResignObserver = center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.stopRingbackTone(reason: "willResignActive")
        }
    }

    /// [2026-05-16] PiP setup. Currently a no-op because LiveKit Swift 2.x
    /// does not publicly surface a CMSampleBuffer feed for VideoTrack — see
    /// the TODO on `pipController`. The function is kept so the wiring is
    /// in one place once a sample-buffer adapter is available.
    private func setupPiPController() {
        guard #available(iOS 15.0, *) else {
            print("[CallVC] PiP unavailable — iOS < 15")
            return
        }
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            print("[CallVC] PiP unavailable — device reports unsupported")
            return
        }
        // TODO(iOS PiP): once a sample-buffer source exists, build
        //   let source = AVPictureInPictureController.ContentSource(
        //       activeVideoCallSourceView: containerView,
        //       contentViewController: pipVideoCallVC // AVPictureInPictureVideoCallViewController
        //   )
        //   self.pipController = AVPictureInPictureController(contentSource: source)
        // and call pipController?.startPictureInPicture() from the
        // background observer below. For now the controller stays nil so
        // we don't ship a half-wired feature that silently fails.
        print("[CallVC] PiP setup deferred — no LK sample-buffer feed yet")
    }

    /// [2026-05-16] Observe app-resignActive so we can auto-start PiP on
    /// background. Once `pipController` becomes non-nil (see TODO above),
    /// this will call `startPictureInPicture()`. Today it just logs.
    private func installBackgroundObserverForPiP() {
        let center = NotificationCenter.default
        pipResignObserver = center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            guard self.hasVideo else { return }
            if #available(iOS 15.0, *), let pip = self.pipController {
                if pip.isPictureInPictureActive == false &&
                   pip.isPictureInPicturePossible {
                    print("[CallVC] willResignActive — startPictureInPicture()")
                    pip.startPictureInPicture()
                }
            } else {
                // No PiP wired today — CallKit's ongoing-call pill in the
                // status bar carries the UX while backgrounded.
                print("[CallVC] willResignActive — PiP not wired, relying on CallKit indicator")
            }
        }
    }

    // Dark status bar style matches the #0B141A background — light glyphs
    // on the system clock/battery indicators.
    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }

    // MARK: - Hangup plumbing

    private func handleHangup() {
        // [2026-05-16] Belt-and-suspenders ringback cleanup — if the user
        // hangs up before the callee picks up, kill the tone immediately
        // so it doesn't bleed into the dismissal animation.
        stopRingbackTone(reason: "handleHangup")
        // [2026-05-16 Stage 2 native WS signaling] Fire call_end from native
        // BEFORE we tear down the room / dismiss. The CallSignalWs serial
        // queue keeps the frame alive even if the VC is deallocated mid-
        // send. JS-side fallback (services/api.js call_end) fires in
        // parallel via the NotificationCenter post below → module observer
        // → JS onCallEnded — server dedupes by call_id.
        CallSignalWs.shared.fireCallEnd(
            callId: callId,
            conversationId: conversationId,
            reason: "user_hangup"
        )
        // Post FIRST, then dismiss — the module observer just needs to know
        // the callId, and posting on the main thread is safe regardless of
        // the dismiss completion timing.
        NotificationCenter.default.post(
            name: CallViewController.callEndedNotification,
            object: nil,
            userInfo: ["callId": callId]
        )
        // [Day 2, 2026-05-16] Release the Room before the VC disappears so
        // LiveKit cleans up its SignalClient + PeerConnection promptly. The
        // Task captures `room` strongly so it survives until disconnect
        // completes; the property is nilled immediately to prevent re-use.
        if let r = self.room {
            self.room = nil
            Task { await r.disconnect() }
        }
        dismiss(animated: true, completion: nil)
    }

    /// Run the LiveKit mute toggle on the local participant. SwiftUI has
    /// already flipped `session.micEnabled` optimistically; if the call
    /// throws we roll the UI back so the button reflects reality.
    private func applyMicEnabled(_ enabled: Bool) {
        guard let r = self.room else {
            print("[CallVC] applyMicEnabled(\(enabled)) — no room, ignoring")
            return
        }
        Task { [weak self] in
            do {
                try await r.localParticipant.setMicrophone(enabled: enabled)
                print("[CallVC] mic toggled — enabled=\(enabled)")
            } catch {
                print("[CallVC] setMicrophone(\(enabled)) failed: \(error)")
                await MainActor.run {
                    self?.session.micEnabled = !enabled
                }
            }
        }
    }

    /// [Day 3, 2026-05-16] Symmetric to applyMicEnabled — toggles the local
    /// camera on the LiveKit room. When the user disables it we also drop
    /// the local preview track so the PiP tile collapses. Re-enabling
    /// re-publishes via setCamera and stores the new track ref.
    private func applyCamEnabled(_ enabled: Bool) {
        guard let r = self.room else {
            print("[CallVC] applyCamEnabled(\(enabled)) — no room, ignoring")
            return
        }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let pub = try await r.localParticipant.setCamera(enabled: enabled)
                await MainActor.run {
                    if enabled {
                        // Update local preview reference if the SDK gave us
                        // a fresh publication (it may reuse an existing one).
                        self.session.localVideoTrack = pub?.track as? LocalVideoTrack
                    } else {
                        self.session.localVideoTrack = nil
                    }
                }
                print("[CallVC] cam toggled — enabled=\(enabled)")
            } catch {
                print("[CallVC] setCamera(\(enabled)) failed: \(error)")
                await MainActor.run {
                    self.session.camEnabled = !enabled
                }
            }
        }
    }

    deinit {
        // Belt-and-suspenders: if the user dismisses via some path that
        // skipped handleHangup, still drop the Room.
        if let r = self.room {
            Task { await r.disconnect() }
        }
        // [2026-05-16] Remove the willResignActive observer (if any).
        if let obs = pipResignObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        pipController = nil
        // [2026-05-16] Ringback cleanup. stopRingbackTone is idempotent
        // and safe to call from deinit (no UI access, no main-thread
        // requirement). Followed by observer removal so we don't leak.
        stopRingbackTone(reason: "deinit")
        if let obs = ringbackResignObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // MARK: - Presentation helper

    /// Present a CallViewController over the top-most VC in the given
    /// VC tree. The module passes the keyWindow's rootViewController; we
    /// walk `presentedViewController` until we find a leaf so we don't
    /// silently fail when there's already a modal on screen.
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
//
// [Day 2, 2026-05-16] Only the four delegate methods required for Day 2
// audio are implemented. RoomDelegate is `@objc optional` so we only get
// callbacks for what we implement — track-subscribe/quality events stay
// off for now (added when Day 3 wires remote video tiles).
extension CallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[CallVC] roomDidConnect — callId=\(callId)")
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "Conectado"
        }
        // [2026-05-16] Note: ringback is INTENTIONALLY not stopped here.
        // roomDidConnect fires when the CALLER's signalling completes —
        // the callee hasn't joined yet. The authoritative spec semantic
        // is "ringback plays until the remote participant joins", which
        // is participantDidConnect / first didSubscribeTrack below.
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[CallVC] didDisconnectWithError — error=\(String(describing: error))")
        // Mirror the user-hangup path: notify the module so JS gets
        // onCallEnded, then dismiss self. Avoid touching `self.room` here
        // since LiveKit will release internals on its own.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [2026-05-16] If we disconnect before the callee picks up
            // (rejected / network error), kill the ringback so it
            // doesn't keep buzzing during dismissal.
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
        // [2026-05-16] Primary ringback termination point — the callee
        // picked up and joined the LiveKit room. Idempotent; if the
        // didSubscribeTrack fires first (race), this is a no-op.
        DispatchQueue.main.async { [weak self] in
            self?.stopRingbackTone(reason: "participantDidConnect")
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        print("[CallVC] participantDidDisconnect — identity=\(participant.identity?.stringValue ?? "?")")
        // If the remote leaves, drop the rendered track so SwiftUI falls
        // back to the avatar / dark background tile.
        DispatchQueue.main.async { [weak self] in
            self?.session.remoteVideoTrack = nil
        }
    }

    // [Day 3, 2026-05-16] Remote video track subscription. LiveKit Swift
    // 2.x fires this for every subscribed track (audio + video); we filter
    // to .video and cast the track to VideoTrack for SwiftUIVideoView.
    // Signature verified against client-sdk-swift main branch
    // (Sources/LiveKit/Protocols/RoomDelegate.swift).
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
            self?.session.remoteVideoTrack = track
            // [2026-05-16] Secondary ringback termination point —
            // remote media is now flowing, ringback would bleed into
            // the conversation if we kept playing. Idempotent.
            self?.stopRingbackTone(reason: "didSubscribeTrack")
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        print("[CallVC] didUnsubscribeTrack — remote video gone")
        DispatchQueue.main.async { [weak self] in
            self?.session.remoteVideoTrack = nil
        }
    }
}
