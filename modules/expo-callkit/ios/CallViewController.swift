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
// [#1184 dismiss fix, 2026-05-19] CXEndCallAction / CXCallController for the
// handleHangup → CallKit dismissal path. Previously handleHangup only ended
// the LK Room + dismissed the UIKit modal, leaving CallKit's system call UI
// (status-bar pill, lock screen) visible until the user dragged it off.
import CallKit

// MARK: - Session state

/// ObservableObject the SwiftUI CallView binds to. Mutations happen on the
/// main thread; the LiveKit delegate callbacks dispatch accordingly. The VC
/// owns the instance for the life of the call.
final class CallSessionState: ObservableObject {
    // Connection / status
    @Published var status: String

    /// [2026-05-21] Set true while LiveKit Room is in `.reconnecting`.
    /// CallView reads this to surface a banner ("Reconectando...") above the
    /// participants grid. Reset to false when the Room comes back to `.connected`
    /// or fully disconnects.
    @Published var isReconnecting: Bool = false

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

    // [WAVE 142 GPT-5.5-pro] Snippet 2 — extra session fields for the polished
    // SwiftUI UI: a backing CallKit UUID so the SwiftUI layer can attach the
    // CallSessionObserver helper, a first-frame flag so the avatar→video
    // crossfade triggers on the real RTC callback (and not on track-arrival),
    // and active-speaker level/flag for the local PiP glow ring.
    @Published var callUUID: UUID? = nil
    @Published var remoteVideoFirstFrame: Bool = false
    @Published var localIsActiveSpeaker: Bool = false
    @Published var localSpeakerLevel: CGFloat = 0

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

// [Wave B/C forward-fix 2026-05-19] `@unchecked Sendable` — LK Swift 2.5+
// declares `public protocol RoomDelegate: AnyObject, Sendable` (verified
// against client-sdk-swift main + 2.5.0 tag). UIViewController isn't
// auto-Sendable under Swift 6 strict concurrency, so without this conformance
// the `Room(delegate: self, ...)` call fails to compile. We control all
// cross-actor access manually via Tasks + MainActor.run + the room/session
// state mutations are already serialized through the main thread.
final class CallViewController: UIViewController, @unchecked Sendable {

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

    // [WAVE 177] Video views — remote fullscreen + local PiP corner
    private var remoteVideoView: VideoView?
    private var localVideoView: VideoView?
    private var remoteVideoObserver: AnyCancellable?
    private var localVideoObserver: AnyCancellable?

    // [WAVE 156 2026-05-22] Combine subscription that mirrors
    // session.status (@Published) into the UIKit statusLabel.
    private var statusObserver: AnyCancellable?
    private var dotsTimer: Timer?
    private var durationTimer: Timer?
    private var callConnectedAt: Date?
    private var dotCount = 0
    private var ringbackActive: Bool = false

    // [DTMF, 2026-05-19] Listen for ExpoCallKitPlayDTMF (posted by the
    // module's playDTMF Function + the CXPlayDTMFCallAction handler) and
    // publish the digit over the LK data channel so the peer (or a SIP
    // bridge) can react. Cleared in deinit.
    private var dtmfObserver: NSObjectProtocol?

    // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] Listen for the system
    // mute action (CXSetMutedCallAction in ProviderDelegate posts this) so
    // toggling mute from the lock-screen / system call bar takes the same
    // fast-path applyMicEnabled uses (track.mute / unmute, no republish).
    private var systemMuteObserver: NSObjectProtocol?

    // [Wave WhatsApp parity, 2026-05-20 gap B5 iOS] Listen for AVAudioSession
    // interruptions (Siri, alarm, PSTN call) and recover the mic after the
    // interruption ends. Without this, post-Siri the user's mic stays
    // muted-by-iOS even though our LK track says it's enabled.
    private var avInterruptionObserver: NSObjectProtocol?

    // [2026-05-22 #1349 fix] Caller-side ringback teardown.
    //
    // Listens for `CallKitCallAnsweredRemote`, posted by CallSignalWs when
    // the callee's `call_accepted` frame lands on our WS. Without this
    // observer the ringback engine kept droning until the 45s outgoing
    // timeout fired even after the peer connected — user feedback:
    // "ringback toca 45s mesmo após o outro lado atender". CallSignalWs
    // already runs the receiver loop; this VC just has to react to the
    // notification it now publishes.
    //
    // Filter by callId so a stale notification from a previous call surface
    // doesn't bleed into this one (same pattern as installSystemMuteObserver).
    // Cleared in deinit.
    private var remoteAnsweredObserver: NSObjectProtocol?

    private var remoteParticipantCount: Int = 0

    // Stash for the mic-enabled state we owned right before an AVAudioSession
    // interruption. Read back when the interruption ends so the user comes
    // out in the same state they went in.
    private var preInterruptionMicEnabled: Bool = true

    // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] Cached LocalAudioTrack
    // reference. Set the first time setMicrophone publishes the track so
    // subsequent toggles can call track.mute() / track.unmute() directly
    // instead of going back through setMicrophone (which re-publishes and
    // re-creates the AVAudioSession-bound RTC sender).
    private var localAudioTrackRef: LocalAudioTrack?

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

        // [Wave B audio, 2026-05-18 / restored 2026-05-19] Centralize
        // AVAudioSession routing.
        //   - Audio call -> earpiece default
        //   - Video call -> speaker default
        //   - BT/wired headset present at start -> route to it (skips default)
        //   - Mid-call BT connect/disconnect -> auto re-route via route listener
        // CallKit owns setActive(); AudioRouter only owns category + port
        // override + the routeChange listener.
        AudioRouter.shared.configureForCall(hasVideo: hasVideo)
        self.session.speakerOn = AudioRouter.shared.speakerOn

        // [DTMF, 2026-05-19] Install the digit-publish bridge.
        installDTMFObserver()

        // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] System call-bar mute.
        installSystemMuteObserver()

        // [Wave WhatsApp parity, 2026-05-20 gap B5 iOS] AVAudioSession recovery.
        installAVInterruptionObserver()

        // [2026-05-22 #1349 fix] Caller-side ringback teardown — wire the
        // CallSignalWs receiver-loop notification so this VC stops the
        // ringback engine the moment the callee's WS accept frame lands.
        installRemoteAnsweredObserver()

        // [WAVE 154 2026-05-22] NUCLEAR — SwiftUI CallView removed entirely.
        //
        // Builds 552-555 ALL crashed in SwiftUI _UIHostingView.layoutSubviews
        // with various flavors of layout/metadata/style recursion. WAVE 153
        // disabled CallView body to Color.black but a CUSTOM ButtonStyle
        // somewhere ELSE in the tree (StyleBodyAccessor) still caused stack
        // overflow in iOS 26.5.
        //
        // Total exhaustion strategy: NO SwiftUI at all in the call screen.
        // Pure UIKit — name label + 3 buttons (mute / speaker / end). All
        // the audio session, AVAudioSession, LiveKit Room, signaling,
        // observers, and hangup logic stays intact and continues to work
        // independently. CallKit native UI shows during ringing as before.
        // When user opens app foreground during call, this minimal UIKit
        // screen shows — no rich animations but zero crash.
        // [WAVE 155 2026-05-22] UIKit call screen — WhatsApp-style polish.
        // Avatar circle + name + status + 3 buttons. Zero SwiftUI.

        // ── WAVE 173 — Full Android-parity UIKit call screen ──────────────
        // Zero SwiftUI. Pure CALayer + UIView + UILabel + UIButton.
        // Matches Android Compose CallScreen: gradient BG, 180pt avatar with
        // pulse rings, glassmorphism buttons, animated dots, top bar with
        // connection bars, duration timer, E2E lock icon, minimize chevron.

        let bounds = UIScreen.main.bounds

        // 1. Gradient background — WhatsApp-grade cinematic deep purple → near-black
        // [WAVE 178 2026-05-24] Tighter contrast, more saturation up top, deeper
        // black at the bottom so the buttons and avatar pop more dramatically.
        let gradient = CAGradientLayer()
        gradient.colors = [
            UIColor(red: 0x2D/255.0, green: 0x12/255.0, blue: 0x5C/255.0, alpha: 1.0).cgColor,  // royal purple
            UIColor(red: 0x1A/255.0, green: 0x0A/255.0, blue: 0x33/255.0, alpha: 1.0).cgColor,  // deep violet
            UIColor(red: 0x07/255.0, green: 0x05/255.0, blue: 0x14/255.0, alpha: 1.0).cgColor   // near-black
        ]
        gradient.locations = [0.0, 0.55, 1.0]
        gradient.startPoint = CGPoint(x: 0.5, y: 0.0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1.0)
        gradient.frame = bounds
        view.layer.insertSublayer(gradient, at: 0)

        // ── TOP BAR (minimize + connection bars + E2E lock) ──
        let topBar = UIView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        let minimizeBtn = UIButton(type: .system)
        minimizeBtn.translatesAutoresizingMaskIntoConstraints = false
        minimizeBtn.tintColor = .white
        let chevCfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        minimizeBtn.setImage(UIImage(systemName: "chevron.down", withConfiguration: chevCfg), for: .normal)
        minimizeBtn.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        minimizeBtn.layer.cornerRadius = 18
        minimizeBtn.clipsToBounds = true
        minimizeBtn.addTarget(self, action: #selector(uikitOnHangupTap), for: .touchUpInside)
        topBar.addSubview(minimizeBtn)

        let barsContainer = UIView()
        barsContainer.translatesAutoresizingMaskIntoConstraints = false
        barsContainer.tag = 9010
        topBar.addSubview(barsContainer)
        for i in 0..<3 {
            let bar = UIView()
            bar.tag = 9011 + i
            bar.backgroundColor = UIColor(red: 0x2E/255.0, green: 0xCC/255.0, blue: 0x71/255.0, alpha: 1.0)
            bar.layer.cornerRadius = 2
            let h: CGFloat = CGFloat(8 + i * 4)
            bar.frame = CGRect(x: CGFloat(i) * 6, y: 16 - h, width: 4, height: h)
            barsContainer.addSubview(bar)
        }

        let lockIcon = UIImageView()
        lockIcon.translatesAutoresizingMaskIntoConstraints = false
        lockIcon.image = UIImage(systemName: "lock.fill")
        lockIcon.tintColor = UIColor.white.withAlphaComponent(0.5)
        lockIcon.contentMode = .scaleAspectFit
        topBar.addSubview(lockIcon)

        // 2. Pulse rings container
        let pulseContainer = UIView()
        pulseContainer.translatesAutoresizingMaskIntoConstraints = false
        pulseContainer.isUserInteractionEnabled = false
        pulseContainer.tag = 9020
        view.addSubview(pulseContainer)

        func addPulseRing(delay: CFTimeInterval) {
            let ring = CAShapeLayer()
            ring.path = UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: 245, height: 245)).cgPath
            ring.fillColor = UIColor.clear.cgColor
            ring.strokeColor = UIColor.white.cgColor
            ring.lineWidth = 2
            ring.frame = CGRect(x: 0, y: 0, width: 245, height: 245)
            ring.opacity = 0

            let scaleAnim = CABasicAnimation(keyPath: "transform.scale")
            scaleAnim.fromValue = 0.76
            scaleAnim.toValue = 1.42
            scaleAnim.duration = 1.8
            scaleAnim.repeatCount = .infinity
            scaleAnim.beginTime = CACurrentMediaTime() + delay

            let fadeAnim = CABasicAnimation(keyPath: "opacity")
            fadeAnim.fromValue = 0.44
            fadeAnim.toValue = 0.0
            fadeAnim.duration = 1.8
            fadeAnim.repeatCount = .infinity
            fadeAnim.beginTime = CACurrentMediaTime() + delay

            ring.add(scaleAnim, forKey: "pulse-scale")
            ring.add(fadeAnim, forKey: "pulse-fade")
            pulseContainer.layer.addSublayer(ring)
        }
        addPulseRing(delay: 0)
        addPulseRing(delay: 0.6)
        addPulseRing(delay: 1.2)

        // 3. Avatar circle — 210pt, gradient purple + real photo async
        // [WAVE 178 2026-05-24] Bumped 180→210 for WhatsApp-grade presence.
        let avatarSize: CGFloat = 210
        let avatarView = UIView()
        avatarView.translatesAutoresizingMaskIntoConstraints = false
        let avatarGradient = CAGradientLayer()
        avatarGradient.colors = [
            UIColor(red: 0x7C/255.0, green: 0x3A/255.0, blue: 0xED/255.0, alpha: 1.0).cgColor,
            UIColor(red: 0x5B/255.0, green: 0x21/255.0, blue: 0xB6/255.0, alpha: 1.0).cgColor
        ]
        avatarGradient.frame = CGRect(x: 0, y: 0, width: avatarSize, height: avatarSize)
        avatarGradient.cornerRadius = avatarSize / 2
        avatarView.layer.addSublayer(avatarGradient)
        avatarView.layer.cornerRadius = avatarSize / 2
        avatarView.clipsToBounds = true
        view.addSubview(avatarView)

        let avatarImageView = UIImageView()
        avatarImageView.translatesAutoresizingMaskIntoConstraints = false
        avatarImageView.contentMode = .scaleAspectFill
        avatarImageView.layer.cornerRadius = avatarSize / 2
        avatarImageView.clipsToBounds = true
        avatarImageView.tag = 9030
        avatarImageView.alpha = 0
        avatarView.addSubview(avatarImageView)

        let displayName = callerName.isEmpty ? callerEmail : callerName
        let initial = String(displayName.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
        let initialLabel = UILabel()
        initialLabel.translatesAutoresizingMaskIntoConstraints = false
        initialLabel.text = initial
        initialLabel.textColor = .white
        initialLabel.font = .systemFont(ofSize: 84, weight: .medium)
        initialLabel.textAlignment = .center
        initialLabel.tag = 9031
        avatarView.addSubview(initialLabel)

        // Async avatar photo fetch
        let avatarEmail = callerEmail
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard !avatarEmail.isEmpty,
                  let url = URL(string: "https://chatyy.com.br/api/email.php?action=get_avatar&email=\(avatarEmail)"),
                  let data = try? Data(contentsOf: url),
                  let img = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self = self,
                      let iv = self.view.viewWithTag(9030) as? UIImageView else { return }
                iv.image = img
                UIView.animate(withDuration: 0.3) {
                    iv.alpha = 1
                    if let lbl = self.view.viewWithTag(9031) { lbl.alpha = 0 }
                }
            }
        }

        // 4. Name + Status labels
        let nameLabel = UILabel()
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.text = displayName
        nameLabel.textColor = .white
        nameLabel.font = .systemFont(ofSize: 32, weight: .regular)
        nameLabel.textAlignment = .center
        nameLabel.numberOfLines = 1
        nameLabel.tag = 9000
        view.addSubview(nameLabel)

        let statusLabel = UILabel()
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = isOutgoing ? "Chamando" : "Conectando"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.65)
        statusLabel.font = .systemFont(ofSize: 16, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.tag = 9001
        view.addSubview(statusLabel)

        // Start animated dots timer (420ms cadence like Android)
        dotsTimer = Timer.scheduledTimer(withTimeInterval: 0.42, repeats: true) { [weak self] _ in
            guard let self = self,
                  let lbl = self.view.viewWithTag(9001) as? UILabel else { return }
            if self.callConnectedAt != nil { return }
            self.dotCount = (self.dotCount + 1) % 4
            let base = self.isOutgoing ? "Chamando" : "Conectando"
            let dots = String(repeating: ".", count: self.dotCount)
            lbl.text = base + dots
        }

        // 5. Glass-morphism buttons
        func glassButton(symbol: String, size: CGFloat, tag: Int, action: Selector, tint: UIColor = UIColor.white.withAlphaComponent(0.16), iconTint: UIColor = .white) -> UIButton {
            let btn = UIButton(type: .system)
            btn.translatesAutoresizingMaskIntoConstraints = false
            btn.layer.cornerRadius = size / 2
            btn.clipsToBounds = true
            btn.tag = tag
            btn.addTarget(self, action: action, for: .touchUpInside)

            let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            blur.frame = CGRect(x: 0, y: 0, width: size, height: size)
            blur.isUserInteractionEnabled = false
            blur.layer.cornerRadius = size / 2
            blur.clipsToBounds = true
            btn.insertSubview(blur, at: 0)

            let overlay = UIView()
            overlay.frame = CGRect(x: 0, y: 0, width: size, height: size)
            overlay.backgroundColor = tint
            overlay.isUserInteractionEnabled = false
            btn.insertSubview(overlay, at: 1)

            btn.layer.borderWidth = 1
            btn.layer.borderColor = UIColor.white.withAlphaComponent(0.22).cgColor

            btn.tintColor = iconTint
            let cfg = UIImage.SymbolConfiguration(pointSize: size * 0.36, weight: .medium)
            btn.setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
            view.addSubview(btn)
            return btn
        }

        // Row 1: mute + speaker + video toggle (3 buttons)
        let muteButton = glassButton(symbol: "mic.fill", size: 64, tag: 9002, action: #selector(uikitOnMuteTap))
        let speakerButton = glassButton(symbol: "speaker.wave.2.fill", size: 64, tag: 9003, action: #selector(uikitOnSpeakerTap))
        let videoButton = glassButton(symbol: "video.fill", size: 64, tag: 9005, action: #selector(uikitOnVideoToggle))

        // Row 2: hangup (center, red, bigger)
        let endButton = glassButton(symbol: "phone.down.fill", size: 72, tag: 9004, action: #selector(uikitOnHangupTap), tint: UIColor(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0, alpha: 1.0))

        // 6. Sub-labels
        func subLabel(_ text: String) -> UILabel {
            let l = UILabel()
            l.translatesAutoresizingMaskIntoConstraints = false
            l.text = text
            l.textColor = UIColor.white.withAlphaComponent(0.7)
            l.font = .systemFont(ofSize: 12, weight: .medium)
            l.textAlignment = .center
            view.addSubview(l)
            return l
        }
        let muteSubLabel = subLabel("Silenciar")
        let speakerSubLabel = subLabel("Alto-falante")
        let videoSubLabel = subLabel("Video")
        let endSubLabel = subLabel("Encerrar")

        // 7. E2E encryption badge
        let e2eBadge = UIView()
        e2eBadge.translatesAutoresizingMaskIntoConstraints = false
        e2eBadge.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        e2eBadge.layer.cornerRadius = 14
        e2eBadge.layer.borderWidth = 0.5
        e2eBadge.layer.borderColor = UIColor.white.withAlphaComponent(0.15).cgColor
        view.addSubview(e2eBadge)

        let e2eLock = UIImageView(image: UIImage(systemName: "lock.fill"))
        e2eLock.translatesAutoresizingMaskIntoConstraints = false
        e2eLock.tintColor = UIColor.white.withAlphaComponent(0.5)
        e2eLock.contentMode = .scaleAspectFit
        e2eBadge.addSubview(e2eLock)

        let e2eLabel = UILabel()
        e2eLabel.translatesAutoresizingMaskIntoConstraints = false
        e2eLabel.text = "Criptografada"
        e2eLabel.textColor = UIColor.white.withAlphaComponent(0.5)
        e2eLabel.font = .systemFont(ofSize: 11, weight: .medium)
        e2eBadge.addSubview(e2eLabel)

        let participantCountLabel = UILabel()
        participantCountLabel.translatesAutoresizingMaskIntoConstraints = false
        participantCountLabel.textColor = UIColor.white.withAlphaComponent(0.7)
        participantCountLabel.font = .systemFont(ofSize: 14, weight: .medium)
        participantCountLabel.textAlignment = .center
        participantCountLabel.tag = 9040
        participantCountLabel.isHidden = !session.isGroup
        view.addSubview(participantCountLabel)

        NSLayoutConstraint.activate([
            // Top bar
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            topBar.heightAnchor.constraint(equalToConstant: 36),

            minimizeBtn.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
            minimizeBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            minimizeBtn.widthAnchor.constraint(equalToConstant: 36),
            minimizeBtn.heightAnchor.constraint(equalToConstant: 36),

            barsContainer.leadingAnchor.constraint(equalTo: minimizeBtn.trailingAnchor, constant: 12),
            barsContainer.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            barsContainer.widthAnchor.constraint(equalToConstant: 22),
            barsContainer.heightAnchor.constraint(equalToConstant: 16),

            lockIcon.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
            lockIcon.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            lockIcon.widthAnchor.constraint(equalToConstant: 16),
            lockIcon.heightAnchor.constraint(equalToConstant: 16),

            // Pulse container (sized to fit the bigger avatar + breathing ring)
            pulseContainer.widthAnchor.constraint(equalToConstant: 245),
            pulseContainer.heightAnchor.constraint(equalToConstant: 245),
            pulseContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pulseContainer.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 48),

            // Avatar (centered inside pulse)
            avatarView.widthAnchor.constraint(equalToConstant: avatarSize),
            avatarView.heightAnchor.constraint(equalToConstant: avatarSize),
            avatarView.centerXAnchor.constraint(equalTo: pulseContainer.centerXAnchor),
            avatarView.centerYAnchor.constraint(equalTo: pulseContainer.centerYAnchor),

            avatarImageView.topAnchor.constraint(equalTo: avatarView.topAnchor),
            avatarImageView.bottomAnchor.constraint(equalTo: avatarView.bottomAnchor),
            avatarImageView.leadingAnchor.constraint(equalTo: avatarView.leadingAnchor),
            avatarImageView.trailingAnchor.constraint(equalTo: avatarView.trailingAnchor),

            initialLabel.centerXAnchor.constraint(equalTo: avatarView.centerXAnchor),
            initialLabel.centerYAnchor.constraint(equalTo: avatarView.centerYAnchor),

            // Name
            nameLabel.topAnchor.constraint(equalTo: pulseContainer.bottomAnchor, constant: 20),
            nameLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            nameLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),

            // Status
            statusLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 8),
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            // E2E badge (below status)
            e2eBadge.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 16),
            e2eBadge.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            e2eBadge.heightAnchor.constraint(equalToConstant: 28),

            e2eLock.leadingAnchor.constraint(equalTo: e2eBadge.leadingAnchor, constant: 10),
            e2eLock.centerYAnchor.constraint(equalTo: e2eBadge.centerYAnchor),
            e2eLock.widthAnchor.constraint(equalToConstant: 12),
            e2eLock.heightAnchor.constraint(equalToConstant: 12),

            e2eLabel.leadingAnchor.constraint(equalTo: e2eLock.trailingAnchor, constant: 6),
            e2eLabel.trailingAnchor.constraint(equalTo: e2eBadge.trailingAnchor, constant: -10),
            e2eLabel.centerYAnchor.constraint(equalTo: e2eBadge.centerYAnchor),

            // Participant count (group calls)
            participantCountLabel.topAnchor.constraint(equalTo: e2eBadge.bottomAnchor, constant: 12),
            participantCountLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            // Button row 1 (3 buttons evenly spaced)
            muteButton.widthAnchor.constraint(equalToConstant: 64),
            muteButton.heightAnchor.constraint(equalToConstant: 64),
            muteButton.bottomAnchor.constraint(equalTo: endButton.topAnchor, constant: -32),
            muteButton.trailingAnchor.constraint(equalTo: speakerButton.leadingAnchor, constant: -24),

            speakerButton.widthAnchor.constraint(equalToConstant: 64),
            speakerButton.heightAnchor.constraint(equalToConstant: 64),
            speakerButton.centerYAnchor.constraint(equalTo: muteButton.centerYAnchor),
            speakerButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            videoButton.widthAnchor.constraint(equalToConstant: 64),
            videoButton.heightAnchor.constraint(equalToConstant: 64),
            videoButton.centerYAnchor.constraint(equalTo: muteButton.centerYAnchor),
            videoButton.leadingAnchor.constraint(equalTo: speakerButton.trailingAnchor, constant: 24),

            // End button (centered, bigger, below)
            endButton.widthAnchor.constraint(equalToConstant: 72),
            endButton.heightAnchor.constraint(equalToConstant: 72),
            endButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            endButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),

            // Sub labels
            muteSubLabel.topAnchor.constraint(equalTo: muteButton.bottomAnchor, constant: 6),
            muteSubLabel.centerXAnchor.constraint(equalTo: muteButton.centerXAnchor),

            speakerSubLabel.topAnchor.constraint(equalTo: speakerButton.bottomAnchor, constant: 6),
            speakerSubLabel.centerXAnchor.constraint(equalTo: speakerButton.centerXAnchor),

            videoSubLabel.topAnchor.constraint(equalTo: videoButton.bottomAnchor, constant: 6),
            videoSubLabel.centerXAnchor.constraint(equalTo: videoButton.centerXAnchor),

            endSubLabel.topAnchor.constraint(equalTo: endButton.bottomAnchor, constant: 6),
            endSubLabel.centerXAnchor.constraint(equalTo: endButton.centerXAnchor),
        ])

        // [WAVE 173] Sync session.status → UIKit statusLabel + duration timer.
        statusObserver = session.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] newStatus in
                guard let self = self else { return }

                if newStatus == "Conectado" && self.callConnectedAt == nil {
                    self.callConnectedAt = Date()
                    self.dotsTimer?.invalidate()
                    self.dotsTimer = nil

                    // Hide pulse rings when connected
                    if let pc = self.view.viewWithTag(9020) {
                        UIView.animate(withDuration: 0.4) { pc.alpha = 0 }
                    }

                    // Start duration timer (1s tick)
                    self.durationTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                        guard let self = self,
                              let connAt = self.callConnectedAt,
                              let lbl = self.view.viewWithTag(9001) as? UILabel else { return }
                        let elapsed = Int(Date().timeIntervalSince(connAt))
                        let h = elapsed / 3600
                        let m = (elapsed % 3600) / 60
                        let s = elapsed % 60
                        if h > 0 {
                            lbl.text = String(format: "Conectado %d:%02d:%02d", h, m, s)
                        } else {
                            lbl.text = String(format: "Conectado %02d:%02d", m, s)
                        }
                    }
                    if let lbl = self.view.viewWithTag(9001) as? UILabel {
                        lbl.text = "Conectado 00:00"
                    }
                } else if newStatus != "Conectado" {
                    if let lbl = self.view.viewWithTag(9001) as? UILabel {
                        lbl.text = newStatus
                    }
                }
            }

        // [STAGE-A 2026-05-20] GAP #2 — If preconnectRoom (push-receive path)
        // already published a Room for this callId, adopt it instead of
        // building a second one. The singleton's Room is either .connecting
        // or .connected; in either case the RoomDelegate hooks fire through
        // NativeCallRoom forwarders + the listener bag, so we don't even need
        // to bind self as a RoomDelegate (CallView reads `session` which
        // mirrors the NativeCallRoom state). This is what makes audio hot
        // the instant the user taps Accept.
        if NativeCallRoom.shared.isPreconnected(callId: callId) {
            print("[CallVC] STAGE-A: adopting preconnected Room for \(callId)")
            // Take over the Room reference + register as RoomDelegate so
            // participant/track events flow into our SwiftUI session state
            // and the existing extension callbacks fire as if we'd built the
            // Room ourselves.
            if let preRoom = NativeCallRoom.shared.currentRoom() {
                self.room = preRoom
                NativeCallRoom.shared.attachDelegate(self)
            }
            // Update session.status if already connected.
            if NativeCallRoom.shared.state == .connected {
                self.session.status = "Conectado"
            }
            // [2026-05-22 #1330 fix] PUBLISH-ON-ANSWER. Because preconnectRoom
            // is now subscribe-only (no setMicrophone during the ring window
            // to avoid ghost-participant on the peer's SFU), we MUST publish
            // the mic here — viewDidLoad runs after CXAnswerCallAction
            // fulfills, so we are in the post-accept path. For video calls we
            // also publish the camera (same as before). Audio still arrives
            // in <500ms because Room.connect already completed during the
            // ring window; we only have to negotiate the outbound track now.
            if let r = self.room {
                Task { [weak self] in
                    guard let self = self else { return }
                    do {
                        let micPub = try await r.localParticipant.setMicrophone(
                            enabled: true,
                            captureOptions: Self.defaultAudioCaptureOptions()
                        )
                        if let track = micPub?.track as? LocalAudioTrack {
                            await MainActor.run { self.localAudioTrackRef = track }
                        }
                        print("[CallVC] STAGE-A: mic published on answer (deferred from preconnect, #1330)")
                    } catch {
                        print("[CallVC] STAGE-A: post-answer mic publish failed: \(error)")
                    }
                    if self.hasVideo {
                        let captureOpts = Self.defaultCameraCaptureOptions(position: self.currentCameraPosition)
                        let publishOpts = Self.defaultVideoPublishOptions()
                        if let pub = try? await r.localParticipant.setCamera(
                            enabled: true,
                            captureOptions: captureOpts,
                            publishOptions: publishOpts
                        ), let track = pub.track as? LocalVideoTrack {
                            await MainActor.run { self.session.localVideoTrack = track }
                            print("[CallVC] STAGE-A: camera published on answer (deferred from preconnect, #1330)")
                        }
                    }
                }
            }
            // PiP still set up based on hasVideo. Ringback skipped — adopt
            // path is always incoming-answered, never outgoing.
            if hasVideo {
                setupPiPController()
                installBackgroundObserverForPiP()
            }
            return
        }

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
            // [Wave B audio, 2026-05-18 / restored 2026-05-19] Default audio
            // capture options carry WebRTC's native AEC + AGC + noise
            // suppression toggles. LiveKit forwards these to the underlying
            // RTCAudioTrack constraints, so the published mic track applies
            // them on every Room.connect. RNNoise (above) layers on top via
            // the customAudioProcessing delegate when the SPM module is
            // present. RoomOptions init signature (LK Swift 2.5+ verified):
            //   init(defaultCameraCaptureOptions:, defaultScreenShareCaptureOptions:,
            //        defaultAudioCaptureOptions:, defaultVideoPublishOptions:,
            //        defaultAudioPublishOptions:, defaultDataPublishOptions:,
            //        adaptiveStream: Bool = false, dynacast: Bool = false, ...)
            // [WAVE 115, 2026-05-21] Relay-first ICE: start with .relay so the
            // first connect always goes over TURN (never NAT-blocked, 200-500ms).
            // Phase-2 upgrade (P2P attempt after 5s) happens in didConnect delegate.
            var roomOpts = RoomOptions(
                defaultCameraCaptureOptions: Self.defaultCameraCaptureOptions(),
                defaultAudioCaptureOptions: Self.defaultAudioCaptureOptions(),
                defaultVideoPublishOptions: Self.defaultVideoPublishOptions(),
                adaptiveStream: true,
                dynacast: true
            )
            // Set iceTransportPolicy = .relay via reflection (not all LK Swift
            // versions expose it as a primary constructor param, but the field
            // has been stable since LK Swift 2.0 on RTCConfiguration).
            do {
                let mirror = Mirror(reflecting: roomOpts)
                for child in mirror.children {
                    if let label = child.label, label.lowercased().contains("rtcconfig") {
                        if var rtcCfg = child.value as? AnyObject {
                            let sel = NSSelectorFromString("setIceTransportPolicy:")
                            if rtcCfg.responds(to: sel) {
                                // RTCIceTransportPolicyRelay = 1
                                rtcCfg.perform(sel, with: NSNumber(value: 1))
                                NSLog("[CallVC] relay-first: iceTransportPolicy=relay set via RTCConfig")
                            }
                        }
                    }
                }
            }
            let r = Room(delegate: self, roomOptions: roomOpts)
            self.room = r
            // [#1207 NativeCallRoom REAL, 2026-05-19] Publish to the singleton
            // BEFORE the await so even if JS races us to `adoptNativeRoom()`
            // mid-connect it sees the same Room reference (state will be
            // `.connecting` until didConnect lands). Publishing here also
            // covers paths where Room.connect throws — `clear()` runs in
            // didDisconnect / catch so JS doesn't get a stale snapshot.
            NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId)

            // [Wave WhatsApp parity, 2026-05-20 gap C5+F3 iOS] Bind the
            // BackgroundProcessor (MediaPipe blur / wallpaper) to this Room so
            // captured camera frames flow through processPixelBuffer before
            // LK encodes them. No-op when BackgroundProcessor.mode == .off,
            // so binding always is safe (zero cost when user hasn't enabled
            // background effects). Must bind BEFORE setCamera() below so the
            // very first published frame already carries the processor.
            BackgroundProcessorLKAdapter.shared.bind(to: r)
            // [Wave WhatsApp parity, 2026-05-20 gap B1] Mirror for the audio
            // path — RNNoise ML noise suppression. Skips silently when the
            // SPM module isn't linked (dlsym fallback returned unavailable).
            RNNoiseLKAdapter.shared.bind(to: r)
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    // [CALL-TRACE 2026-05-20 WAVE42] Step 8/12 — viewDidLoad
                    // path connect (non-preconnect — fresh CallVC mount).
                    NSLog("[CallTrace][8/12] LK Room.connect roomName=\(self.callId) serverUrl=\(url) tokenLen=\(token.count) path=viewDidLoad")
                    try await r.connect(url: url, token: token)
                    NSLog("[CallTrace][8b/12] LK Room state=\(r.connectionState) after connect (path=viewDidLoad)")
                    // [Wave B audio, 2026-05-18 / restored 2026-05-19] Pin
                    // AudioCaptureOptions on the first publish too — RoomOptions
                    // defaults usually carry it, but pinning per-call defense-
                    // in-depth: WhatsApp-grade means AEC + AGC + noise
                    // suppression on *every* connect. LK Swift 2.5+ signature:
                    //   setMicrophone(enabled: Bool, captureOptions:
                    //                 AudioCaptureOptions? = nil,
                    //                 publishOptions: AudioPublishOptions? = nil)
                    //   async throws -> LocalTrackPublication?
                    let micPub = try await r.localParticipant.setMicrophone(
                        enabled: true,
                        captureOptions: Self.defaultAudioCaptureOptions()
                    )
                    // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] Cache the
                    // local mic track so subsequent applyMicEnabled toggles
                    // take the track.mute() / unmute() fast-path. setMicrophone
                    // returns the publication directly on LK 2.5+.
                    if let track = micPub?.track as? LocalAudioTrack {
                        await MainActor.run { self.localAudioTrackRef = track }
                    }
                    print("[CallVC] Mic published (aec+agc+ns) — callId=\(self.callId)")
                    if self.hasVideo {
                        // [Wave C, 2026-05-18] Pass explicit captureOptions +
                        // publishOptions so the *first* publish carries our
                        // simulcast tiers. Room-level defaults set above already
                        // do this, but some LK Swift revs ignore the RoomOptions
                        // default on the first setCamera() call — pinning per-
                        // call defense-in-depth.
                        let captureOpts = Self.defaultCameraCaptureOptions(position: self.currentCameraPosition)
                        let publishOpts = Self.defaultVideoPublishOptions()
                        if let pub = try? await r.localParticipant.setCamera(
                            enabled: true,
                            captureOptions: captureOpts,
                            publishOptions: publishOpts
                        ), let track = pub.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.session.localVideoTrack = track
                            }
                            print("[CallVC] Camera published (simulcast=true preset=h720_169) — callId=\(self.callId)")
                        }
                    }
                } catch {
                    print("[CallVC] connect/mic failed: \(error)")
                    // [#1207 NativeCallRoom REAL] If Room.connect threw, the
                    // singleton holds a non-connected room — clear it so a
                    // future adoptNativeRoom doesn't hand JS a stale dead
                    // reference. JS will fall back to its own Room.connect
                    // (the legacy path) which is fine for the error case.
                    NativeCallRoom.shared.clear()
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

    // [#1171 redux dismiss, 2026-05-19] Guard so handleHangup only runs once.
    // The SwiftUI red button can fire onHangup twice on rapid double-tap; the
    // LK `didDisconnectWithError` delegate ALSO calls dismiss; CXEndCallAction
    // (when fired by handleHangup) loops back through ProviderDelegate which
    // calls dismissActiveCallSurfaces. Without this guard each path runs its
    // full teardown (Room disconnect, CXEndCallAction, dismiss) which can
    // race and leave the VC in a half-dismissed state on slower devices.
    private var didHangup: Bool = false

    private func handleHangup() {
        if didHangup {
            // Second tap (or delegate-driven re-entry) — only re-issue the
            // dismiss in case the first one was swallowed by a presentation
            // race. Cheap and idempotent.
            forceDismissSelf(reason: "handleHangup_reentry")
            return
        }
        didHangup = true
        stopRingbackTone(reason: "handleHangup")
        // [#1171 redux dismiss, 2026-05-19] Update the visible status BEFORE
        // any async teardown. Previously the VC stayed at "Conectando…" while
        // LK disconnect + CXEndCallAction churned for 200-800ms; if the
        // dismiss animation was preempted (e.g. PiP, presenter mid-transition)
        // the user was stranded staring at "Conectando…" with no signal that
        // their hangup had registered. WhatsApp/FaceTime show "Encerrada"
        // for ~250ms before the screen fades — mirror that.
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "Encerrada"
        }
        // [Wave B audio, 2026-05-18 / restored 2026-05-19] Drop the route-
        // change listener + clear the speakerphone override before LK
        // disconnect so the next call (or expo-audio session) starts with a
        // clean AVAudioSession state.
        AudioRouter.shared.teardown()
        // Stop PiP if still active so the system pill is clean on dismissal.
        if #available(iOS 15.0, *), let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        // [Wave WhatsApp parity, 2026-05-20 gap G4 iOS] Tear down the
        // OngoingCallBar overlay if it was mounted (audio minimize path).
        OngoingCallBarOverlayController.shared.uninstall()
        CallSignalWs.shared.fireCallEnd(
            callId: callId,
            conversationId: conversationId,
            reason: "user_hangup",
            targetEmail: callerEmail
        )
        NotificationCenter.default.post(
            name: CallViewController.callEndedNotification,
            object: nil,
            userInfo: ["callId": callId]
        )
        if let r = self.room {
            self.room = nil
            // [#1207 NativeCallRoom REAL] Drop the singleton's reference so
            // adoptNativeRoom() returns nil for any subsequent call. Mirrors
            // didDisconnect path; runs in handleHangup because user-initiated
            // hangup teardown happens BEFORE the LK disconnect callback lands.
            NativeCallRoom.shared.clear()
            // [WAVE 166 battle-tested disconnect 2026-05-23] Task.detached +
            // timeout + retry pattern from LiveKit Swift SDK Issues #583,
            // #729, #757 (officially recommended workaround thread maintainer
            // 2025-08). Replaces fire-and-forget `Task { await r.disconnect() }`
            // which had 3 known failure modes:
            //   #583 — cleanUpRTC() not called when Task is interrupted →
            //          next Room.connect() fails (audio/video render dies).
            //          Fix: drop strong refs BEFORE await (self.room = nil above).
            //   #729 — disconnect() never returns on flaky network → Task
            //          leaks holding Room ref → memory grows + peer sees
            //          "Conectado" stale forever. Fix: 3s timeout via
            //          withTaskGroup, cancel and move on.
            //   #757 — SignalClient.socket = nil race during reconnect →
            //          sendLeave() fails silently → peer thinks we're still
            //          connected. Maintainer workaround: call disconnect()
            //          again if connectionState != .disconnected after first.
            // Room is @unchecked Sendable (Room.swift line 31: `public class
            // Room: NSObject, @unchecked Sendable, ...`) so the cross-actor
            // capture is safe under Swift 6 strict concurrency. Task.detached
            // breaks the @MainActor isolation chain inherited from
            // CallViewController so the disconnect doesn't race the audio
            // session teardown that CallKit does in provider:didDeactivate:.
            Task.detached(priority: .userInitiated) {
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { await r.disconnect() }
                    group.addTask {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                    }
                    _ = await group.next()
                    group.cancelAll()
                }
                if r.connectionState != .disconnected {
                    print("[CallVC] handleHangup: LK disconnect retry — connectionState=\(r.connectionState)")
                    await r.disconnect()
                }
            }
        }
        // [#1184 dismiss fix, 2026-05-19] Fire CXEndCallAction so CallKit
        // tears down its own state (system call bar, lock-screen UI, the
        // green "ongoing call" pill at the top of the status bar). Without
        // this, tapping the SwiftUI red button only dismissed our UIKit
        // modal — CallKit still believed the call was active and left its
        // surfaces visible after hangup, which the user reported as
        // "depois que a ligação desliga, a tela nativa fica aberta".
        //
        // CXEndCallAction is async and may invalidate the call before our
        // dismiss completes. The ProviderDelegate.CXEndCallAction handler
        // also calls dismissActiveCallSurfaces — idempotent vs. our explicit
        // dismiss below.
        if let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId) {
            // [WAVE 158 2026-05-22] BELT-AND-SUSPENDERS: fire BOTH reportCall
            // AND CXEndCallAction. User reported: even after WAVE 157, CallKit
            // pill still stuck "Conectando" when canceling outgoing before
            // peer answered.
            //
            // Apple state machine for outgoing calls:
            // 1. CXStartCallAction.fulfill() → call exists in provider list
            // 2. reportOutgoingCall(startedConnectingAt:) → "Calling..."
            // 3. reportOutgoingCall(connectedAt:) → "Connected" (only after WS
            //    confirms peer answered, since WAVE 156)
            //
            // To terminate:
            // - reportCall(.unanswered) — valid from ANY state before connected
            // - CXEndCallAction — only valid AFTER connected
            //
            // WAVE 157 picked one based on `isOutgoing && status != "Conectado"`.
            // But: earlyProvider might be nil (race during cold-start), and
            // the fallback was CXEndCallAction which silently fails on a
            // not-yet-connected call. So pill stayed.
            //
            // WAVE 158 fix: try BOTH. iOS accepts whichever is valid for the
            // current state; the other is a safe no-op. We don't even need
            // to guess.
            // [WAVE 159 2026-05-22] Fire reportCall on BOTH providers — the
            // module's main provider (which owns outgoing calls) AND the
            // earlyProvider (which owns incoming-from-VoIP-push calls).
            // Whichever one registered THIS call will react; the other is
            // a no-op. Was firing only earlyProvider before, which is why
            // outgoing calls' pill stayed ghost on screen.
            //
            // CXProvider.reportCall is idempotent and safe to call on a
            // provider that doesn't know the UUID, so dual-fire is correct.
            var hitAtLeastOne = false
            if let p = ExpoCallKitModule.sharedProvider {
                p.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
                print("[CallVC] handleHangup reportCall(.unanswered) via sharedProvider uuid=\(uuid)")
                hitAtLeastOne = true
            }
            if let p = VoipPushAppDelegateSubscriber.earlyProvider, p !== ExpoCallKitModule.sharedProvider {
                p.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
                print("[CallVC] handleHangup reportCall(.unanswered) via earlyProvider uuid=\(uuid)")
                hitAtLeastOne = true
            }
            if !hitAtLeastOne {
                print("[CallVC] handleHangup: NO providers available — relying on CXEndCallAction")
            }
            let controller = CXCallController(queue: .main)
            let action = CXEndCallAction(call: uuid)
            controller.request(CXTransaction(action: action)) { error in
                if let error = error {
                    print("[CallVC] handleHangup CXEndCallAction error: \(error.localizedDescription)")
                } else {
                    print("[CallVC] handleHangup CXEndCallAction requested ok uuid=\(uuid)")
                }
            }
        } else {
            print("[CallVC] handleHangup: no shared UUID for \(callId) — NUCLEAR: ending ALL CXCalls")
        }
        // [WAVE 170 nuclear fallback] Enumerate ALL active CXCalls and end
        // each one. Covers the case where our callId→UUID map is stale or
        // never populated (outgoing calls started from JS with a different
        // ID format). CXCallObserver.calls is synchronous and returns every
        // call CallKit knows about. Ending a call that's already ended is
        // a no-op (CXCallController dedupes). This is the same approach
        // WhatsApp uses — they end ALL calls on hangup, never look up by ID.
        let observer = CXCallObserver()
        let activeCalls = observer.calls.filter { !$0.hasEnded }
        if !activeCalls.isEmpty {
            print("[CallVC] handleHangup: NUCLEAR ending \(activeCalls.count) active CXCall(s)")
            let ctrl = CXCallController(queue: .main)
            for call in activeCalls {
                let endAction = CXEndCallAction(call: call.uuid)
                ctrl.request(CXTransaction(action: endAction)) { error in
                    if let error = error {
                        print("[CallVC] NUCLEAR CXEndCallAction \(call.uuid) error: \(error.localizedDescription)")
                    } else {
                        print("[CallVC] NUCLEAR CXEndCallAction \(call.uuid) OK")
                    }
                }
                // Also report on both providers as belt-and-suspenders
                ExpoCallKitModule.sharedProvider?.reportCall(with: call.uuid, endedAt: Date(), reason: .remoteEnded)
                VoipPushAppDelegateSubscriber.earlyProvider?.reportCall(with: call.uuid, endedAt: Date(), reason: .remoteEnded)
            }
        }
        forceDismissSelf(reason: "handleHangup")
    }

    /// [#1171 redux dismiss, 2026-05-19] Robust dismiss that survives the
    /// three real failure modes we've seen with `self.dismiss(animated:)`:
    ///
    ///   1. `self.presentingViewController` is nil — happens if the modal
    ///      was presented and the presenter chain was reset (rare, but real
    ///      on cold-start + VoIP push paths where the root VC swaps mid-call).
    ///      In that case `self.dismiss` is a silent no-op and the modal sits
    ///      forever — exactly the "Conectando…" complaint. Falling back to
    ///      `presentingViewController?.dismiss` and to a window-level removal
    ///      covers the gap.
    ///   2. `self` is mid-presentation (the present transaction started but
    ///      hasn't finished). Dismiss called during that window is dropped by
    ///      UIKit. The 50ms retry on the next runloop tick catches this.
    ///   3. A sibling modal (audio picker, share sheet) is on top of us when
    ///      hangup fires; `self.dismiss` then dismisses the SIBLING and leaves
    ///      the call VC up. Walking up via `presentingViewController` lets the
    ///      presenter tear down its chain (which UIKit cascades through children).
    private func forceDismissSelf(reason: String) {
        // Path 1 — standard dismiss. UIKit cascades to children correctly when
        // the receiver is the presenter.
        let presenter = self.presentingViewController
        self.dismiss(animated: true) { [weak self] in
            print("[CallVC] forceDismissSelf(\(reason)) primary dismiss completed")
            self?.verifyDismissed(reason: reason)
        }
        // Path 2 — belt-and-braces. If primary dismiss is a no-op (no
        // presenter) UIKit silently swallows it; ask the presenter directly.
        // UIKit dedupes if both succeed.
        if let presenter = presenter, presenter.presentedViewController === self {
            DispatchQueue.main.async { [weak presenter] in
                presenter?.dismiss(animated: true, completion: nil)
            }
        }
    }

    /// Second-stage dismiss check — fires ~250ms after the primary dismiss
    /// completion. If `view.window` is still non-nil, the VC is still
    /// attached to a window scene; remove it from its parent or detach the
    /// view manually so the user doesn't end up staring at a stuck
    /// "Conectando…" forever.
    private func verifyDismissed(reason: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self else { return }
            guard self.view.window != nil else { return }
            print("[CallVC] verifyDismissed(\(reason)): view still attached, forcing teardown")
            // Last-resort: walk the chain via the active scene's root VC and
            // dismiss any VC named CallViewController. This is what
            // ProviderDelegate.dismissActiveCallSurfaces does and it's known
            // to handle the cross-window cases.
            ExpoCallKitModule.dismissActiveCallSurfacesFromVC(reason: "verify_" + reason)
        }
    }

    private func applyMicEnabled(_ enabled: Bool) {
        guard let r = self.room else { return }
        // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] Mute/unmute the
        // existing RTC audio sender instead of re-publishing. Re-publishing
        // tears down the SFU path + races the CallKit-owned audio session.
        // Mirrors the camera fast-path in applyCamEnabled (lines 598-601):
        // the peer gets the standard WebRTC "muted" signal while audio
        // routing stays intact. First-time enable (no track yet) falls
        // through to setMicrophone() with capture options for AEC + AGC + NS.
        Task { [weak self] in
            guard let self = self else { return }
            do {
                // Find the already-published local mic track. We try the
                // session-cached reference first (set on first publish below)
                // and fall back to LK's localParticipant audio publications
                // accessor. If neither yields a track yet, take the legacy
                // setMicrophone path to perform the first publish — that path
                // also carries AudioCaptureOptions (AEC+AGC+NS+highpass+typing)
                // so the first published frame has the WebRTC DSP toggles.
                if let track = self.localAudioTrackRef {
                    if enabled {
                        try await track.unmute()
                    } else {
                        try await track.mute()
                    }
                    print("[CallVC] mic \(enabled ? "unmute" : "mute") (cached, no republish) — callId=\(self.callId)")
                } else {
                    try await r.localParticipant.setMicrophone(
                        enabled: enabled,
                        captureOptions: Self.defaultAudioCaptureOptions()
                    )
                    // Cache the freshly published track. Resolve via Mirror so
                    // a minor-rev LK Swift API rename (audioTracks property
                    // ↔ method ↔ trackPublications filter) doesn't break the
                    // build. Look for any child labelled `audioTracks` whose
                    // value is iterable; pull the first LocalAudioTrack we can
                    // find on its `.track` property.
                    let mirror = Mirror(reflecting: r.localParticipant)
                    var found: LocalAudioTrack? = nil
                    for child in mirror.children where child.label == "audioTracks" {
                        if let arr = child.value as? [Any] {
                            for pub in arr {
                                let pubMirror = Mirror(reflecting: pub)
                                for c2 in pubMirror.children where c2.label == "track" {
                                    if let t = c2.value as? LocalAudioTrack { found = t; break }
                                }
                                if found != nil { break }
                            }
                        }
                        if found != nil { break }
                    }
                    await MainActor.run { self.localAudioTrackRef = found }
                    print("[CallVC] mic first-publish enabled=\(enabled) cached=\(found != nil) — callId=\(self.callId)")
                }
            } catch {
                print("[CallVC] applyMicEnabled(\(enabled)) failed: \(error)")
                await MainActor.run { self.session.micEnabled = !enabled }
            }
        }
        // __chatyy_native_call_sync 2026-05-19 — module observer forwards
        // to onLkLocalAudioChanged so JS analytics + recording banner reflect
        // the native toggle (was a silent black hole before).
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkLocalAudioChanged"),
            object: nil,
            userInfo: ["enabled": enabled]
        )
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
                    // First-time enable: full publish with simulcast tiers.
                    let captureOpts = Self.defaultCameraCaptureOptions(position: self.currentCameraPosition)
                    let publishOpts = Self.defaultVideoPublishOptions()
                    let pub = try await r.localParticipant.setCamera(
                        enabled: true,
                        captureOptions: captureOpts,
                        publishOptions: publishOpts
                    )
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
        // __chatyy_native_call_sync 2026-05-19 — mirror to JS so peer-video
        // gating + recording banner + post-call rating see the toggle.
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkLocalVideoChanged"),
            object: nil,
            userInfo: ["enabled": enabled]
        )
    }

    /// [Wave B audio, 2026-05-18 / restored 2026-05-19] Speaker toggle now
    /// delegates to AudioRouter so route-change listener stays consistent
    /// with UI state. If a BT/wired headset is connected, the router will
    /// keep it as the route — pressing "speaker" still flips the loudspeaker
    /// on; pressing it again returns to the headset rather than the earpiece
    /// (matches AudioRouter logic).
    private func applySpeaker(_ enabled: Bool) {
        let actual = AudioRouter.shared.setSpeaker(enabled)
        // Reflect the actual state into the SwiftUI session so the UI shows
        // the right toggle position even if the router clamped it.
        DispatchQueue.main.async { [weak self] in
            self?.session.speakerOn = actual
        }
        // __chatyy_native_call_sync 2026-05-19 — fire both onLkSpeakerChanged
        // (boolean) and onAudioRouteChanged (string) so JS sees the resolved
        // route. setSpeaker(...) may clamp to BT/wired if they're connected —
        // onAudioRouteChanged carries the truth from AVAudioSession itself.
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let route: String
        if actual {
            route = "speaker"
        } else if outputs.contains(where: { $0.portType == .bluetoothA2DP || $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE }) {
            route = "bluetooth"
        } else if outputs.contains(where: { $0.portType == .headphones || $0.portType == .headsetMic || $0.portType == .usbAudio }) {
            route = "headset"
        } else {
            route = "earpiece"
        }
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkSpeakerChanged"),
            object: nil,
            userInfo: ["enabled": actual]
        )
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitAudioRouteChanged"),
            object: nil,
            userInfo: ["route": route]
        )
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
        // __chatyy_native_call_sync 2026-05-19 — JS local-preview mirror flag
        // follows the native camera position so the PiP renderer (or any
        // hybrid overlay) can mirror the front-facing image correctly.
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkCameraFlipped"),
            object: nil,
            userInfo: ["front": next == .front]
        )
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
            do {
                let opts = Self.defaultCameraCaptureOptions(position: next)
                let pub = try await r.localParticipant.setCamera(
                    enabled: true,
                    captureOptions: opts,
                    publishOptions: Self.defaultVideoPublishOptions()
                )
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

    /// [#1189 features, 2026-05-19] Call hold via CallKit. Tapping "Colocar em
    /// espera" in the More sheet was previously a cosmetic toggle that never
    /// touched the system call bar or LK Room — peer kept hearing audio.
    /// Now: CXSetHeldCallAction routes through ProviderDelegate, which mutes
    /// mic + pauses the LK Room, and the system call bar shows the "On hold"
    /// glyph so the user can resume from the lock screen or the green pill.
    private func applyHold(_ held: Bool) {
        guard let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId) else {
            print("[CallVC] applyHold(\(held)): no shared UUID — falling back to mic toggle")
            // Fallback: if CallKit isn't tracking this call (rare edge case
            // via WS-fast-path before CallKit reported), at least mute the
            // mic so the peer doesn't hear audio while "on hold".
            applyMicEnabled(!held)
            return
        }
        let controller = CXCallController(queue: .main)
        let action = CXSetHeldCallAction(call: uuid, onHold: held)
        controller.request(CXTransaction(action: action)) { [weak self] error in
            if let error = error {
                print("[CallVC] applyHold CXSetHeldCallAction error: \(error.localizedDescription)")
                // Revert optimistic UI flip on failure.
                DispatchQueue.main.async { self?.session.onHold = !held }
                return
            }
            DispatchQueue.main.async { self?.session.onHold = held }
            // __chatyy_native_call_sync 2026-05-19 — module observer forwards
            // to onCallHoldChanged so JS analytics and the recording banner
            // pause/resume in lockstep with the CallKit system hold glyph.
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitCallHoldChanged"),
                object: nil,
                userInfo: ["held": held]
            )
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

    /// Minimize → Picture in Picture for video; floating OngoingCallBar for
    /// audio. WhatsApp parity: an audio call should leave a tap-to-restore
    /// chip on the top of the screen, not just vanish. Without the chip the
    /// user often forgets the call is live and walks out of the app.
    ///
    /// [Wave WhatsApp parity, 2026-05-20 gap G4 iOS] Audio path now mounts
    /// `OngoingCallBarOverlay` (declared in CallView.swift) on the key window
    /// at z-order +100 so it sits above every JS surface. Tap → re-present
    /// CallViewController. Dismissed when handleHangup() runs.
    private func handleMinimize() {
        if #available(iOS 15.0, *),
           let pip = pipController,
           pip.isPictureInPicturePossible,
           !pip.isPictureInPictureActive {
            pip.startPictureInPicture()
            return
        }
        // No PiP (audio-only or unsupported device): install floating bar +
        // dismiss self. The bar is owned by OngoingCallBarOverlayController
        // which holds a weak ref to us so tap-to-restore can re-present.
        // startedAt: best-effort = now. The bar reads CallSessionState
        // directly for the canonical elapsed timer, but we hand a fallback
        // so the bar appears immediately even before the first session tick.
        OngoingCallBarOverlayController.shared.install(
            callerName: callerName,
            hasVideo: hasVideo,
            startedAt: Date(),
            onTapRestore: { [weak self] in
                self?.restoreFromMinimize()
            }
        )
        dismiss(animated: true, completion: nil)
    }

    /// [Wave C-1, 2026-05-21] Chat button handler: post an
    /// `ExpoCallKitOpenChat` notification (observed in ExpoCallKitModule which
    /// calls `safeSendEvent("onOpenChat", …)`) and then minimise the call to
    /// PiP / floating bar so the chat thread is visible. Mirrors the WhatsApp
    /// pattern — call stays alive in PiP while the conversation screen opens.
    private func openChat() {
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitOpenChat"),
            object: nil,
            userInfo: [
                "callId": callId,
                "conversationId": conversationId
            ]
        )
        // Minimise so JS navigation is reachable.
        handleMinimize()
    }

    /// [Wave WhatsApp parity, 2026-05-20 gap G4 iOS] Re-present this VC when
    /// the user taps the floating OngoingCallBar. We rely on
    /// ProviderDelegate's presenter resolver to handle the case where the JS
    /// shell pushed new VCs while we were minimised.
    fileprivate func restoreFromMinimize() {
        OngoingCallBarOverlayController.shared.uninstall()
        // Re-present over the current key VC. Walk the chain to find the
        // top-most so we don't get stuck behind a JS modal.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let scene = UIApplication.shared.connectedScenes
                    .compactMap({ $0 as? UIWindowScene })
                    .first(where: { $0.activationState == .foregroundActive }),
                  let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
                return
            }
            var top: UIViewController = root
            while let next = top.presentedViewController { top = next }
            if top !== self {
                self.modalPresentationStyle = .fullScreen
                top.present(self, animated: true, completion: nil)
            }
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

    // MARK: - DTMF keypad (2026-05-19)
    //
    // The module's `playDTMF` Expo function + the ProviderDelegate's
    // CXPlayDTMFCallAction handler both post `ExpoCallKitPlayDTMF` so we
    // have a single path to test: subscribe here, marshal the digit to the
    // LK Room as a data frame, and let the system tone play on its own
    // (AudioServicesPlaySystemSound is fired from the module + tone-handed
    // CallKit dispatches its own tone for the system keypad).
    //
    // Data frame format: `D:<digit>`. Mirrors the `R:<emoji>` reaction
    // protocol so receivers demux easily. A SIP/PSTN bridge consuming this
    // can convert to RFC 2833 in-band tones, which is how PSTN IVRs see
    // keypad input. For peer-to-peer Chatyy↔Chatyy calls the receiver can
    // optionally flash the digit as an in-call toast (future polish).
    private func installDTMFObserver() {
        guard dtmfObserver == nil else { return }
        dtmfObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitPlayDTMF"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let digit = note.userInfo?["digit"] as? String,
                  !digit.isEmpty else { return }
            self?.publishDTMF(digit: digit)
        }
    }

    /// [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] React to the system
    /// CallKit mute button. ProviderDelegate.provider(_:perform:CXSetMutedCallAction)
    /// posts `ExpoCallKitSystemMuteChanged` with the desired muted state;
    /// we flip `session.micEnabled` (UI in sync) AND call applyMicEnabled
    /// which takes the track.mute()/unmute() fast-path. Filter by callId so
    /// a stale notification from a previous call doesn't bleed in.
    private func installSystemMuteObserver() {
        guard systemMuteObserver == nil else { return }
        systemMuteObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitSystemMuteChanged"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            guard let muted = note.userInfo?["muted"] as? Bool else { return }
            if let nid = note.userInfo?["callId"] as? String,
               !nid.isEmpty, nid != self.callId {
                // Notification arrived for a different active call surface;
                // ignore — the other VC will pick it up.
                return
            }
            let nextEnabled = !muted
            if self.session.micEnabled == nextEnabled { return }
            self.session.micEnabled = nextEnabled
            self.applyMicEnabled(nextEnabled)
        }
    }

    /// [Wave WhatsApp parity, 2026-05-20 gap B5 iOS] AVAudioSession recovery.
    /// Siri / alarm / GSM call grabs the audio session out from under us;
    /// when it ends iOS asks the app to re-activate. Without this handler
    /// the user gets stuck in a half-state where the LK track says mic-on
    /// but the AVAudioSession has no live input route → "they don't hear me".
    /// We re-activate the session and re-apply the mic state we owned
    /// pre-interruption.
    private func installAVInterruptionObserver() {
        guard avInterruptionObserver == nil else { return }
        avInterruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            guard let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch kind {
            case .began:
                print("[CallVC] AVAudioSession interruption began — pausing mic state")
                // Stash desired state so .ended can restore. Use the SwiftUI
                // session as source of truth (mutated by user toggles + the
                // system mute observer).
                self.preInterruptionMicEnabled = self.session.micEnabled
            case .ended:
                var shouldResume = true
                if let optsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                    let opts = AVAudioSession.InterruptionOptions(rawValue: optsRaw)
                    shouldResume = opts.contains(.shouldResume)
                }
                print("[CallVC] AVAudioSession interruption ended — shouldResume=\(shouldResume)")
                guard shouldResume else { return }
                do {
                    try AVAudioSession.sharedInstance().setActive(true, options: [])
                } catch {
                    print("[CallVC] post-interruption setActive failed: \(error)")
                }
                // Re-apply the mic state we owned before the interruption.
                // Bypass the cached fast-path here on purpose: after Siri /
                // GSM, the AVAudioSession-bound RTC sender can be in a
                // half-state where track.mute()/unmute() flips bits but the
                // underlying audio unit is still attached to the previous
                // (Siri-owned) session. Going back through setMicrophone
                // forces LK to re-attach to the now-active session.
                let desired = self.preInterruptionMicEnabled
                Task { [weak self] in
                    guard let self = self, let r = self.room else { return }
                    do {
                        try await r.localParticipant.setMicrophone(
                            enabled: desired,
                            captureOptions: Self.defaultAudioCaptureOptions()
                        )
                        // Clear cached track ref so next mute uses the new one.
                        await MainActor.run { self.localAudioTrackRef = nil }
                        print("[CallVC] post-interruption setMicrophone(\(desired)) ok — callId=\(self.callId)")
                    } catch {
                        print("[CallVC] post-interruption setMicrophone failed: \(error)")
                    }
                }
            @unknown default:
                break
            }
        }
    }

    /// [2026-05-22 #1349 fix] Caller-side ringback teardown observer.
    /// Posted by CallSignalWs.handleIncomingCallAcceptedLocked when the
    /// callee's `call_accepted` frame arrives on the WS receiver loop.
    /// We stop the ringback engine, flip the visible status to "Connected",
    /// and let the existing LK didConnect / participantDidConnect path
    /// do the rest of the connect UX. Filters by callId so a stale
    /// notification from a previous outgoing surface doesn't bleed in
    /// (matches installSystemMuteObserver pattern). Idempotent vs. the
    /// LK didSubscribeTrack path which ALSO calls stopRingbackTone — the
    /// ringbackActive guard inside stopRingbackTone makes a second call
    /// a cheap no-op.
    private func installRemoteAnsweredObserver() {
        guard remoteAnsweredObserver == nil else { return }
        remoteAnsweredObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("CallKitCallAnsweredRemote"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            // CallSignalWs writes both "callId" and "call_id" to userInfo;
            // tolerate either spelling so a future refactor (or alternate
            // emitter) can't silently break the filter.
            let nid = (note.userInfo?["callId"] as? String)
                ?? (note.userInfo?["call_id"] as? String)
                ?? ""
            if !nid.isEmpty, nid != self.callId {
                // Different call surface — let its own observer handle.
                return
            }
            print("[CallVC] remote-answered \(self.callId) — stopping ringback + flipping status")
            self.stopRingbackTone(reason: "remote_answered")
            self.session.status = "Conectado"

            // [WAVE 156 2026-05-22] Moved here from roomDidConnect.
            // CallKit only learns "the remote answered" AFTER the WS frame
            // arrives — otherwise the pill says "Conectado" the moment our
            // SFU join completes (before the callee accepts), which is the
            // root cause of the caller hearing audio before answer.
            if self.isOutgoing,
               let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: self.callId),
               let provider = VoipPushAppDelegateSubscriber.earlyProvider {
                provider.reportOutgoingCall(with: uuid, connectedAt: nil)
                print("[CallVC] remote-answered: reportOutgoingCall(connectedAt:nil) uuid=\(uuid)")
            }
        }
    }

    /// Local handler — called by the SwiftUI CallView keypad. Plays the
    /// matching system tone (so the user gets immediate audible feedback
    /// even before the data frame is acked) and forwards to the same path
    /// the NotificationCenter observer uses so logic stays single-source.
    private func handlePlayDTMF(_ digit: String) {
        guard let first = digit.first else { return }
        let baseId: UInt32 = {
            switch first {
            case "0": return 1200
            case "1": return 1201
            case "2": return 1202
            case "3": return 1203
            case "4": return 1204
            case "5": return 1205
            case "6": return 1206
            case "7": return 1207
            case "8": return 1208
            case "9": return 1209
            case "*": return 1210
            case "#": return 1211
            case "A": return 1212
            case "B": return 1213
            case "C": return 1214
            case "D": return 1215
            default: return 0
            }
        }()
        if baseId != 0 {
            AudioServicesPlaySystemSound(SystemSoundID(baseId))
        }
        publishDTMF(digit: String(first))
    }

    /// Send `D:<digit>` on the LK data channel. No-op if the room isn't
    /// connected yet (e.g. during early ringing before answer).
    private func publishDTMF(digit: String) {
        guard let r = self.room else { return }
        let payload = "D:" + digit
        guard let data = payload.data(using: .utf8) else { return }
        Task {
            do {
                try await r.localParticipant.publish(data: data)
            } catch {
                print("[CallVC] publish DTMF '\(digit)' failed: \(error)")
            }
        }
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
        // [2026-05-19 forward-fix] Dimensions(width: Int32, height: Int32) —
        // Swift does NOT auto-promote Int literals to Int32; cast explicitly
        // to keep Archive compile happy on LK Swift 2.5+.
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
    ///
    /// [Wave WhatsApp parity, 2026-05-20 gap C1+C4]
    ///   - `preferredCodec: .vp9` + `backupCodec: .vp8` — VP9 cuts ~30% bitrate
    ///     vs VP8 at the same perceptual quality. SFU negotiates VP9 with peers
    ///     that support it; falls back to VP8 for everyone else.
    ///   - `encoding.maxBitrate` bumped 1.7M → 2.0M so the VP9 top simulcast
    ///     tier can carry the extra fidelity headroom (would otherwise cap out
    ///     at the same VP8 bitrate and the quality bump would be invisible).
    ///   - `degradationPreference: .balanced` (was implicit) — drop fps before
    ///     resolution under congestion.
    static func defaultVideoPublishOptions() -> VideoPublishOptions {
        return VideoPublishOptions(
            name: nil,
            encoding: VideoEncoding(
                maxBitrate: 2_000_000, // 2.0 Mbps cap for VP9 top tier
                maxFps: 30
            ),
            simulcast: true,
            preferredCodec: .vp9,
            // [Wave 19 fix] LK iOS 2.0.x VideoPublishOptions has no backupCodec
            // param yet. SFU falls back to negotiated codec list automatically.
            degradationPreference: .balanced
        )
    }

    /// [Wave B audio, 2026-05-18 / restored 2026-05-19] AudioCaptureOptions
    /// tuned for WhatsApp-grade voice. All five WebRTC DSP toggles are ON:
    ///   - `echoCancellation`     → AEC3 strips the speaker feedback on
    ///                              loudspeaker calls (mandatory for video
    ///                              calls and any speaker-on toggle).
    ///   - `autoGainControl`      → normalizes mic level so soft-spoken users
    ///                              don't get drowned out and loud users
    ///                              don't clip the encoder.
    ///   - `noiseSuppression`     → WebRTC's built-in NS (separate from
    ///                              RNNoise). Cheap baseline; RNNoise wraps
    ///                              on top as the "ML-grade" upgrade when
    ///                              available.
    ///   - `highpassFilter`       → low-cut removes 60Hz hum / mic handling
    ///                              rumble.
    ///   - `typingNoiseDetection` → suppresses keyboard click bursts.
    /// LK 2.5+ AudioCaptureOptions defaults already enable all five:
    /// echoCancellation, noiseSuppression, autoGainControl, typingNoiseDetection,
    /// highpassFilter. Past attempts to spell out the args got tripped up on
    /// the init's actual labeled-arg order, so just take the defaults.
    static func defaultAudioCaptureOptions() -> AudioCaptureOptions {
        return AudioCaptureOptions()
    }

    // MARK: - Deinit

    deinit {
        if let r = self.room {
            // [#1207 NativeCallRoom REAL] Belt-and-braces: usually handleHangup
            // or didDisconnect have already cleared the singleton by the time
            // deinit runs, but the PiP path and force-quit can short-circuit
            // those. Idempotent — clear() on an already-empty singleton is
            // a no-op print.
            NativeCallRoom.shared.clear()
            Task { await r.disconnect() }
        }
        if let obs = pipResignObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = dtmfObserver { NotificationCenter.default.removeObserver(obs); dtmfObserver = nil }
        if let obs = systemMuteObserver { NotificationCenter.default.removeObserver(obs); systemMuteObserver = nil }
        if let obs = avInterruptionObserver { NotificationCenter.default.removeObserver(obs); avInterruptionObserver = nil }
        // [2026-05-22 #1349 fix] Caller-side ringback teardown observer.
        if let obs = remoteAnsweredObserver { NotificationCenter.default.removeObserver(obs); remoteAnsweredObserver = nil }
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
        // [Wave B audio, 2026-05-18 / restored 2026-05-19] Belt-and-braces —
        // handleHangup tears down the router on user-initiated end, deinit
        // covers room-disconnect / PiP dismiss paths.
        AudioRouter.shared.teardown()
    }

    // MARK: - Presentation helper

    /// [STAGE-A 2026-05-20] GAP #2 — Pre-connect the LiveKit Room DURING the
    /// CallKit ring window (i.e. before the user taps Accept). Same plumbing
    /// as the `viewDidLoad` connect path minus the SwiftUI presentation: we
    /// build a Room, publish to NativeCallRoom (so adoptNativeRoom / the
    /// CXAnswer path can adopt it instantly), and kick the connect Task.
    ///
    /// Audio is hot the instant the user taps Accept — there's no second
    /// Room.connect round-trip after CXAnswer fires. WhatsApp parity.
    static func preconnectRoom(url: String, token: String, callId: String) {
        guard !url.isEmpty, !token.isEmpty, !callId.isEmpty else {
            print("[CallVC] preconnectRoom: missing url/token/callId — skip")
            return
        }
        // Bail if a Room is already mid-connect for this call (idempotent).
        if NativeCallRoom.shared.isPreconnected(callId: callId) {
            print("[CallVC] preconnectRoom: already pre-connected for \(callId) — skip")
            return
        }
        // Touch processor singletons so the first published audio frame sees
        // the user's RNNoise / background-blur toggle state.
        _ = RNNoiseAudioProcessor.shared
        _ = BackgroundProcessor.shared
        // [WAVE 115, 2026-05-21] Relay-first ICE — same policy as viewDidLoad path.
        let roomOptions = RoomOptions(
            defaultCameraCaptureOptions: Self.defaultCameraCaptureOptions(),
            defaultAudioCaptureOptions: Self.defaultAudioCaptureOptions(),
            defaultVideoPublishOptions: Self.defaultVideoPublishOptions(),
            adaptiveStream: true,
            dynacast: true
        )
        // delegate: nil — there's no VC yet. CallViewController.viewDidLoad
        // (called when present() lands) will rebind its own RoomDelegate via
        // the singleton's published Room reference. Until then, NativeCallRoom
        // .didConnect forwarders fire via the JS adoptNativeRoom listener bag.
        let r = Room(delegate: nil, roomOptions: roomOptions)
        NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId)
        Task.detached(priority: .userInitiated) {
            do {
                // [CALL-TRACE 2026-05-20 WAVE42] Step 8/12 — iOS dials the
                // LK SFU on the preconnect path. The viewDidLoad async-connect
                // path (~line 365) has its own [8/12] tracer below if used.
                NSLog("[CallTrace][8/12] LK Room.connect roomName=\(callId) serverUrl=\(url) tokenLen=\(token.count) path=preconnect")
                try await r.connect(url: url, token: token)
                NSLog("[CallTrace][8b/12] LK Room state=\(r.connectionState) after connect (path=preconnect)")
                // [2026-05-22 #1330 fix] PUBLISH DEFERRAL — do NOT call
                // setMicrophone(enabled: true) here during the ring window.
                //
                // Previously this preconnect path published the mic track the
                // moment the SFU handshake resolved, BEFORE the user had even
                // tapped Accept in CallKit. Result: the peer's SFU saw a live
                // publisher in the room and forwarded our audio downstream
                // immediately. If the callee then declined / let it ring out
                // / iOS went to sleep, the peer was left with a "ghost"
                // participant — connected with audio, no UI, no way to hang
                // up cleanly. (Ticket #1330.)
                //
                // Fix: stay subscribe-only during the ring window. We are
                // still connected to the SFU (so audio is hot the instant
                // we publish) and we still receive remote tracks via
                // auto-subscribe — we just don't push anything outbound.
                // The mic publish moves to CallViewController.viewDidLoad
                // (the adopt branch ~line 289), which runs only after
                // CXAnswerCallAction fulfills — i.e. the user actually
                // accepted. No publish = no ghost on the peer's SFU.
                NativeCallRoom.shared.didConnect()
                print("[CallVC] preconnectRoom: connected (subscribe-only, mic publish deferred to answer) callId=\(callId)")
            } catch {
                NSLog("[CallTrace][8b/12] LK Room connect FAILED err=\(error) (path=preconnect)")
                print("[CallVC] preconnectRoom: failed callId=\(callId) err=\(error)")
                NativeCallRoom.shared.clear()
            }
        }
    }

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
        // [WAVE 146 2026-05-22] Completion handler tells us if UIKit actually
        // attached the view to the window hierarchy. Without it, present can
        // silently no-op (already presenting, view not in scene) and the
        // user sees nothing. Now any drop logs visibly in Console.app.
        NSLog("[CallVC.present] about to present top=\(type(of: top)) callId=\(callId)")
        nativeCallDiag("callvc_about_to_present", callId, "top=\(type(of: top))")
        top.present(vc, animated: true, completion: {
            let attached = vc.view.window != nil
            NSLog("[CallVC.present] completion fired callId=\(callId) window=\(attached)")
            nativeCallDiag("callvc_present_completion", callId, "attached_to_window=\(attached)")
        })
    }

    private static func topMostViewController(from base: UIViewController) -> UIViewController {
        var top: UIViewController = base
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    // [WAVE 154 2026-05-22] UIKit-only button handlers (no SwiftUI).

    // [WAVE 178 2026-05-24] Haptic + scale press feedback for WhatsApp-grade
    // tactile response. Layered so every call-control button has a 100ms
    // dimming scale-down before firing the actual action.
    private func tapFeedback(_ btn: UIButton?) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        guard let btn = btn else { return }
        UIView.animate(withDuration: 0.08, animations: {
            btn.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        }, completion: { _ in
            UIView.animate(withDuration: 0.12, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.8, options: [.allowUserInteraction], animations: {
                btn.transform = .identity
            })
        })
    }

    @objc private func uikitOnHangupTap() {
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        tapFeedback(view.viewWithTag(9004) as? UIButton)
        handleHangup()
    }

    @objc private func uikitOnMuteTap() {
        // session.micEnabled = mic ENABLED. Mute = micEnabled false.
        let newMicEnabled = !session.micEnabled
        applyMicEnabled(newMicEnabled)
        let btn = view.viewWithTag(9002) as? UIButton
        tapFeedback(btn)
        if let btn = btn {
            let cfg = UIImage.SymbolConfiguration(pointSize: 26, weight: .medium)
            btn.setImage(UIImage(systemName: newMicEnabled ? "mic.fill" : "mic.slash.fill", withConfiguration: cfg), for: .normal)
        }
    }

    @objc private func uikitOnSpeakerTap() {
        let next = !session.speakerOn
        applySpeaker(next)
        let btn = view.viewWithTag(9003) as? UIButton
        tapFeedback(btn)
        if let btn = btn {
            let cfg = UIImage.SymbolConfiguration(pointSize: 26, weight: .medium)
            btn.setImage(UIImage(systemName: next ? "speaker.wave.2.fill" : "speaker.slash.fill", withConfiguration: cfg), for: .normal)
        }
    }

    @objc private func uikitOnVideoToggle() {
        let desired = !session.camEnabled
        session.camEnabled = desired
        applyCamEnabled(desired)
        let btn = view.viewWithTag(9005) as? UIButton
        tapFeedback(btn)
        if let btn = btn {
            let cfg = UIImage.SymbolConfiguration(pointSize: 26, weight: .medium)
            btn.setImage(UIImage(systemName: desired ? "video.fill" : "video.slash.fill", withConfiguration: cfg), for: .normal)
        }
    }

    private func updateParticipantCountLabel() {
        guard let lbl = view.viewWithTag(9040) as? UILabel else { return }
        let total = remoteParticipantCount + 1
        if session.isGroup && remoteParticipantCount > 0 {
            lbl.text = "\(total) participantes"
            lbl.isHidden = false
        } else if session.isGroup {
            lbl.text = "Aguardando participantes..."
            lbl.isHidden = false
        } else {
            lbl.isHidden = true
        }
    }

    private func cleanupCallTimers() {
        dotsTimer?.invalidate()
        dotsTimer = nil
        durationTimer?.invalidate()
        durationTimer = nil
    }
}

// MARK: - RoomDelegate

extension CallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        // [CALL-TRACE 2026-05-20 WAVE42] Step 9/12 — RoomDelegate.connected.
        NSLog("[CallTrace][9/12] RoomEvent type=Connected callId=\(callId) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        print("[CallVC] roomDidConnect — callId=\(callId)")

        // [WAVE 156 2026-05-22] CRITICAL fix audio leak: do NOT flip session.status
        // to "Conectado" and do NOT call reportOutgoingCall(connectedAt:) here.
        //
        // Bug user reported: "outro celular tá em casa começa a chamar e EU já
        // escuto barulho como se atenderam". Root cause: roomDidConnect fires
        // when the LiveKit SFU acknowledges OUR join (not when the callee
        // accepted) — and we were prematurely telling CallKit + UI "Connected",
        // which (a) opens the audio session fully on both sides, (b) starts the
        // in-call duration timer, and (c) primes the caller speaker so any
        // remote audio plays immediately. Even though the callee hasn't tapped
        // Accept, our mic is hot and the SFU forwards anything to other peers
        // in the room.
        //
        // Correct behavior (WhatsApp parity): keep status = "Chamando…" until
        // the WS receives the `call_answered` frame from the callee's device.
        // The CallSignalWs notification flips status AND calls
        // reportOutgoingCall(connectedAt:) — see installRemoteAnsweredObserver
        // below (line ~1438) where the proper transition lives now.
        // [#1207 NativeCallRoom REAL] Fanout to JS via the singleton listener
        // so the JS-side /call.js sees onLkConnected and renders peers from
        // the snapshot without spinning up a duplicate Room.
        NativeCallRoom.shared.didConnect()
        // [WAVE 115, 2026-05-21 / WAVE 119, 2026-05-22] Relay-first Phase-2:
        // 1s after Connected on TURN relay, trigger ICE restart with policy
        // 'all' so WebRTC tries a direct P2P candidate. If P2P wins, media
        // migrates silently (lower RTT/latency). If P2P fails the relay leg
        // stays uninterrupted. Was 5s in WAVE 115; WAVE 119 tightens to 1s
        // (most successful candidate pairs complete ICE checks in 200-800ms,
        // so 5s left ~80% of the upgrade window on the table). The relay
        // leg keeps media flowing across the restartIce, so this is
        // invisible to the user.
        // LK Swift exposes room.engine.publisher which is an RTCPeerConnection
        // wrapper — call restartIce() on it directly.
        // [WAVE 162 2026-05-23] Was 1s in WAVE 119 — caused "chiada quando
        // conectou" because DTLS re-negotiate + audio path swap mid-frame
        // (200-800ms window). Move back to 5s (WAVE 115 timing) — most
        // calls have stable relay by then, audio settled, swap to P2P happens
        // silently or fails silently keeping relay leg.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { [weak self, weak room] in
            guard let self = self, let r = room else { return }
            // [6th Swift compile cause, build cd37bbe] didHangup is on the VC, not session.
            guard !self.didHangup else { return }
            NSLog("[CallVC][relay-first] Phase-2: attempting P2P upgrade via engine.publisher.restartIce")
            // Access the publisher PeerConnection through LK Swift internals.
            // [2026-05-21] LK SDK v2.5+ made `room.engine` `internal` — direct
            // property access fails to compile. We walk the Room's Mirror
            // children to find the engine ivar without going through the
            // typed property. Mirror reflection sees ivars regardless of
            // their declared access level.
            let roomMirror = Mirror(reflecting: r)
            var engineValue: Any? = nil
            for c in roomMirror.children {
                if c.label == "engine" || c.label == "_engine" {
                    engineValue = c.value
                    break
                }
            }
            guard let eng = engineValue else {
                NSLog("[CallVC][relay-first] Phase-2: room.engine ivar not found via Mirror (LK SDK changed?)")
                return
            }
            let engMirror = Mirror(reflecting: eng)
            for child in engMirror.children {
                if let label = child.label,
                   (label == "publisher" || label == "pcManager"),
                   let pub = child.value as? AnyObject {
                    let sel = NSSelectorFromString("restartIce")
                    if pub.responds(to: sel) {
                        pub.perform(sel)
                        NSLog("[CallVC][relay-first] Phase-2: restartIce() called on \(label)")
                    }
                    // Also walk pub for a nested .pc / .peerConnection
                    let pubMirror = Mirror(reflecting: pub)
                    for pchild in pubMirror.children {
                        if let plabel = pchild.label,
                           (plabel == "pc" || plabel == "peerConnection"),
                           let pc = pchild.value as? AnyObject {
                            if pc.responds(to: sel) {
                                pc.perform(sel)
                                NSLog("[CallVC][relay-first] Phase-2: restartIce() called on pub.\(plabel)")
                            }
                        }
                    }
                }
            }
        }
    }

    /// [2026-05-21] Reconnect lifecycle banner. When the underlying transport
    /// briefly drops (cellular handoff, brief Wi-Fi blip) LK swaps to
    /// `.reconnecting`; we surface "Reconectando…" so the user doesn't think
    /// the call is silent. On `.connected` after reconnect we flip back to
    /// "Conectado"; full `.disconnected` is handled by `didDisconnectWithError`
    /// further below but we keep the status synced here too.
    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldValue: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .reconnecting:
                self.session.status = "Reconectando..."
                self.session.isReconnecting = true
            case .connected:
                if self.session.isReconnecting {
                    self.session.status = "Conectado"
                    self.session.isReconnecting = false
                }
            case .disconnected:
                self.session.status = "Desconectado"
                self.session.isReconnecting = false
            default: break
            }
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        // [CALL-TRACE 2026-05-20 WAVE42] Step 9/12 — RoomDelegate.disconnect.
        NSLog("[CallTrace][9/12] RoomEvent type=Disconnected callId=\(callId) err=\(String(describing: error)) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        print("[CallVC] didDisconnectWithError — error=\(String(describing: error))")
        // [#1207 NativeCallRoom REAL] Fanout to JS BEFORE we tear down the
        // session. JS listeners need the disconnect event so they can swap
        // back to the chat header / call list. We also clear() so a future
        // adoptNativeRoom call doesn't see a stale snapshot.
        let reasonStr: String = (error.map { String(describing: $0) }) ?? "remote_ended"
        NativeCallRoom.shared.didDisconnect(reason: reasonStr)
        NativeCallRoom.shared.clear()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [#1171 redux dismiss, 2026-05-19] Mark didHangup so a follow-up
            // user red-button tap doesn't run the full teardown a second time
            // (Room is already gone; CXEndCallAction would still fire but
            // CallSignalWs.fireCallEnd would duplicate the server-side BYE).
            // Re-entrant calls still trigger forceDismissSelf via handleHangup.
            self.didHangup = true
            // [#1171 redux dismiss, 2026-05-19] Update visible status BEFORE
            // teardown so the user sees the call is ending — same rationale
            // as handleHangup. Mostly relevant for peer-end / network-drop
            // where the user didn't tap hangup themselves.
            self.session.status = "Encerrada"
            self.stopRingbackTone(reason: "didDisconnectWithError")
            NotificationCenter.default.post(
                name: CallViewController.callEndedNotification,
                object: nil,
                userInfo: ["callId": self.callId]
            )
            // [#1184 dismiss fix, 2026-05-19] Also tell CallKit the call has
            // ended. LK Room disconnect happens when the peer leaves the
            // room, the SFU tears it down, or the local network drops — in
            // none of those paths does the standard CXEndCallAction fire on
            // its own, so without this the CallKit pill/lock-screen UI stays
            // visible after the call ends.
            //
            // We use `reportCall(with:endedAt:reason:.remoteEnded)` (not
            // CXEndCallAction) because the call ended remotely; this also
            // marks the call as "Missed/Ended" rather than "Cancelled" in
            // the iOS Recents tab, matching what WhatsApp / FaceTime show.
            if let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: self.callId) {
                let provider = VoipPushAppDelegateSubscriber.earlyProvider
                if let p = provider {
                    let reason: CXCallEndedReason = (error != nil) ? .failed : .remoteEnded
                    p.reportCall(with: uuid, endedAt: Date(), reason: reason)
                    print("[CallVC] didDisconnectWithError: reportCall(.remoteEnded) uuid=\(uuid)")
                } else {
                    print("[CallVC] didDisconnectWithError: no earlyProvider — CallKit may stay visible")
                }
            }
            // [#1171 redux dismiss, 2026-05-19] Use the robust path so
            // peer-end / network-drop paths get the same fallback coverage
            // (no-presenter, mid-transition, sibling modal) as user-initiated
            // hangup. Old path was `self.dismiss(animated: true, completion: nil)`
            // which silently no-op'd on the presenter-mid-transition case
            // and stranded the user on "Conectando…".
            self.forceDismissSelf(reason: "didDisconnectWithError")
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        // [CALL-TRACE 2026-05-20 WAVE42] Step 9/12 — RoomDelegate.peerJoin.
        // Equivalent to "peer joined the SFU room" — should fire on the
        // caller's device shortly after the callee answers.
        NSLog("[CallTrace][9/12] RoomEvent type=ParticipantConnected identity=\(identity) callId=\(callId) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        print("[CallVC] participantDidConnect — identity=\(identity)")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.stopRingbackTone(reason: "participantDidConnect")
            // [WAVE 161 2026-05-23] Restore the status-flip fallback that WAVE 156
            // accidentally removed. WAVE 156 correctly stopped roomDidConnect (=
            // OUR join, premature) from flipping status, but it ALSO removed the
            // participantDidConnect path — leaving the WS `call_answered` frame
            // as the ONLY source for "Chamando…→Conectado". When that frame is
            // lost (cold-start auth race, network blip, or the bug where Android
            // CallSignalWs doesn't unwrap the C++ envelope), iOS sat in
            // "Chamando…" for the full 45s.
            //
            // ParticipantConnected is the TRUTHFUL "peer joined" event — it
            // fires on the caller's RoomDelegate only when the remote peer's
            // device successfully connects to the LK SFU, which happens AFTER
            // they tap Accept (Android sends call_answered → CXAnswer →
            // room.connect → join confirmed = this event). It is NOT premature
            // and does NOT cause the audio-leak that WAVE 156 was fixing.
            //
            // Idempotent: if WS `call_answered` already flipped status earlier,
            // setting it to "Conectado" again is a no-op. Same for
            // reportOutgoingCall(connectedAt:) — CallKit dedups internally.
            if self.session.status != "Conectado" {
                self.session.status = "Conectado"
                NSLog("[CallVC][WAVE161] flip status Conectado on ParticipantConnected (fallback)")
            }
            // Also flip CallKit pill from "Connecting…" → in-call duration timer.
            if let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: self.callId) {
                if let p = ExpoCallKitModule.sharedProvider {
                    p.reportOutgoingCall(with: uuid, connectedAt: Date())
                    NSLog("[CallVC][WAVE161] reportOutgoingCall(connectedAt:) on ParticipantConnected")
                }
            }
            self.remoteParticipantCount += 1
            self.updateParticipantCountLabel()
        }
        // [#1207 NativeCallRoom REAL] Fanout so JS chat header / call grid
        // can mark the peer as joined.
        NativeCallRoom.shared.participantConnected(identity: identity,
                                                   name: participant.name)
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        // [CALL-TRACE 2026-05-20 WAVE42] Step 9/12 — peer left the SFU.
        NSLog("[CallTrace][9/12] RoomEvent type=ParticipantDisconnected identity=\(identity) callId=\(callId) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        print("[CallVC] participantDidDisconnect — identity=\(identity)")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // 1:1 fallback: clear the remote video track when the peer leaves.
            self.session.remoteVideoTrack = nil
            self.remoteParticipantCount = max(0, self.remoteParticipantCount - 1)
            self.updateParticipantCountLabel()
        }
        // [#1207 NativeCallRoom REAL] Fanout so JS can drop the peer tile.
        NativeCallRoom.shared.participantDisconnected(identity: identity)
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        let identity = participant.identity?.stringValue ?? "?"
        let kind = (publication.kind == .video) ? "video" : "audio"
        // [#1207 NativeCallRoom REAL] Fanout subscribe for BOTH audio + video
        // so JS hears about every track. The local VC only cares about
        // video (renders the tile), but JS-side analytics / grid may want to
        // know when audio tracks get attached too.
        NativeCallRoom.shared.trackSubscribed(participantId: identity,
                                              trackSid: "\(publication.sid)",
                                              kind: kind)
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else {
            print("[CallVC] didSubscribeTrack — video pub but track cast failed")
            return
        }
        print("[CallVC] didSubscribeTrack — remote video, identity=\(identity)")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // 1:1 path: keep remoteVideoTrack for the full-bleed background.
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
        let identity = participant.identity?.stringValue ?? "?"
        let kind = (publication.kind == .video) ? "video" : "audio"
        // [#1207 NativeCallRoom REAL] Fanout unsubscribe for both kinds.
        NativeCallRoom.shared.trackUnsubscribed(participantId: identity,
                                                trackSid: "\(publication.sid)",
                                                kind: kind)
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
        let qualityStr: String
        switch quality {
        case .excellent: qualityStr = "excellent"
        case .good:      qualityStr = "good"
        case .poor:      qualityStr = "poor"
        default:         qualityStr = "unknown"
        }
        // [#1207 NativeCallRoom REAL] Fanout for ALL participants — JS may
        // surface remote quality in the group/cohost grids.
        let identity = participant.identity?.stringValue ?? "?"
        NativeCallRoom.shared.connectionQualityChanged(identity: identity, quality: qualityStr)
        // Only react locally for the local participant; remote participants'
        // quality bars don't surface in the 1:1 UI.
        guard participant.identity?.stringValue == room.localParticipant.identity?.stringValue else { return }
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
              forTopic topic: String,
              encryptionType: EncryptionType) {
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
        // [Bridge #3 2026-05-19] Notify JS so the chat header / OngoingCallBar
        // can shrink while the call docks. Mirrors the Android path
        // CallActivity.onPictureInPictureModeChanged → emitPipChanged. The
        // module's PiP notification observer translates this NSNotification
        // into the `onPipChanged` JS event (Events list line 183).
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitPipChanged"),
            object: nil,
            userInfo: ["inPip": true]
        )
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
        // [Bridge #3 2026-05-19] Symmetric exit event.
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitPipChanged"),
            object: nil,
            userInfo: ["inPip": false]
        )
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
