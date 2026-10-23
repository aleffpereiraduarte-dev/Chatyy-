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
import Network  // [video-quality 2026-10-06] NWPathMonitor snapshot for the profile picker
import AVFoundation
import CoreMedia  // [2026-10-11 full-hd] CMVideoFormatDescriptionGetDimensions (1080p capability probe)
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
/// [2026-10-08 call-connect-fast] Serialises CallViewController.preconnectRoom's
/// check-and-publish (called concurrently from Task.detached ring-window kicks).
private let kPreconnectRoomLock = NSLock()

/// [2026-10-14 publish-wait] "Publisher is nil" / LiveKitError 101/104 (iOS
/// stage_a camera, fresh-connect mic, gate publish, group VC): publishing
/// (setMicrophone / setCamera / publish(videoTrack:)) while the Room is not
/// `.connected` — still joining, or `.reconnecting` right after the join —
/// throws. Wait for `.connected` (RoomStateWaiter, bounded, no polling) before
/// EACH attempt and retry shortly. A `.disconnected` Room is left to the
/// caller's rejoin path (gives up at once). Free function = no actor
/// isolation (callers run in MainActor Tasks of the call view controllers).
func lkPublishWhenConnected<T>(_ r: Room,
                               callId: String,
                               label: String,
                               attempts: Int = 3,
                               _ op: () async throws -> T) async throws -> T {
    var lastError: Error?
    let total = max(1, attempts)
    for attempt in 1...total {
        if r.connectionState != .connected {
            let st = await RoomStateWaiter.wait(room: r, timeout: 8.0)
            if st != .connected {
                nativeCallDiag("publish_wait_not_connected", callId,
                               "what=\(label) attempt=\(attempt) lk=\(NativeCallRoom.stateName(st))")
                lastError = NSError(domain: "ChatyyCallPublish", code: -1,
                                    userInfo: [NSLocalizedDescriptionKey: "not_connected lk=\(NativeCallRoom.stateName(st)) (\(label))"])
                if st == .disconnected { break }
                continue
            }
        }
        do {
            let out = try await op()
            if attempt > 1 { nativeCallDiag("publish_ok_after_retry", callId, "what=\(label) attempt=\(attempt)") }
            return out
        } catch {
            lastError = error
            nativeCallDiag("publish_retry", callId,
                           "what=\(label) attempt=\(attempt) lk=\(NativeCallRoom.stateName(r.connectionState)) err=\(String(String(describing: error).prefix(140)))")
            if attempt < total { try? await Task.sleep(nanoseconds: 500_000_000) }
        }
    }
    throw lastError ?? NSError(domain: "ChatyyCallPublish", code: -2,
                               userInfo: [NSLocalizedDescriptionKey: "publish_failed (\(label))"])
}

final class CallViewController: UIViewController, @unchecked Sendable {

    static let callEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // [minimize-drop fix 2026-05-26] Strong holder that keeps a MINIMIZED call
    // VC alive. The incoming-answer flow presents this VC as a plain modal, so
    // the ONLY strong ref is the presenting VC. When handleMinimize() dismisses
    // the modal, ARC would dealloc us — and then "return to call" (tapping the
    // OngoingCallBar pill / closing PiP) would have no VC to re-present, AND the
    // old deinit tore down the Room. We park `self` here on minimize so the SAME
    // VC — still bound as the live Room's RoomDelegate, still holding the audio/
    // video views — survives and can be re-presented + show live media on
    // return. Cleared on restoreFromMinimize() and on real hangup teardown.
    private static var minimizedInstance: CallViewController?

    // [2026-10-11 ongoing-call] Weak pointer to the live 1:1 call VC (on screen,
    // minimized or in PiP) so OngoingCallState can build the JS snapshot and
    // the in-app call bar (components/CallStatusBar.js) can restore / mute /
    // hang up without JS ever touching the Room.
    private static weak var liveInstance: CallViewController?
    /// Became visible at least once (a VC still being presented is NOT "minimized").
    private var hasAppearedOnce = false

    let callId: String
    let callerName: String
    let callerEmail: String
    let hasVideo: Bool

    private var lkUrl: String? // [2026-10-15 call-open-fast] var: late token
    private var lkToken: String? // [2026-10-15 call-open-fast] var: late token
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
    // [2026-10-14 pip-frozen] avatar card over the PiP video + stall watch.
    private weak var pipContainer: PiPSampleBufferView?
    private var pipStallTimer: Timer?

    // Ringback
    // [2026-10-13 ringback] AVAudioPlayer (in-memory WAV, 425 Hz 1 s on / 4 s
    // off) instead of a private AVAudioEngine: the engine was started in
    // viewDidLoad BEFORE CallKit's didActivate, so the CallKit activation /
    // LiveKit VPIO bring-up reconfigured the session (new HW sample rate,
    // AVAudioEngineConfigurationChange) and the engine stopped silently with
    // nothing restarting it ("não toca o tuu… tuu…"). See startRingbackTone.
    private var ringbackPlayer: AVAudioPlayer?
    private var ringbackResignObserver: NSObjectProtocol?
    /// Caller wants the ringback (set at dial, cleared by stopRingbackTone).
    private var ringbackWanted: Bool = false
    private var ringbackStartWork: DispatchWorkItem?
    private var ringbackWatchdog: Timer?
    private var ringbackSessionObservers: [NSObjectProtocol] = []
    private var ringbackRebuilds: Int = 0
    private var ringbackStartedAt: Date?

    // [WAVE 177] Video views — remote fullscreen + local PiP corner
    private var remoteVideoView: VideoView?
    private var localVideoView: VideoView?
    // [2026-10-14 self-view] Caller's camera captured LOCALLY while ringing
    // (WhatsApp shows your own camera before the peer answers). NOT published
    // (ring-leak gate) — published as-is in openOutgoingMicGate on answer.
    private var outgoingPreviewTrack: LocalVideoTrack?
    // [2026-10-14 self-view] Tap the self-view tile = swap main/mini.
    private var videoSwapped: Bool = false
    private var remoteVideoObserver: AnyCancellable?
    private var localVideoObserver: AnyCancellable?

    // [#1358 video parity 2026-05-25] Floating-reaction renderer state.
    private var reactionsObserver: AnyCancellable?
    private var animatedReactionIds: Set<UUID> = []

    // [#1358 video parity 2026-05-25] Container for the local-camera PiP tile
    // (rounded card holding `localVideoView` + a small flip button). Draggable
    // with FaceTime-style edge snap. Held separately from `localVideoView` so
    // the corner radius / border / shadow / pan gesture live on the wrapper and
    // the VideoView stays a plain fill renderer inside it.
    private var localPipContainer: UIView?
    private var pipPanOrigin: CGPoint = .zero
    // Whether the remote camera is currently rendering full-bleed video. Drives
    // the controls-scrim layout switch + auto-hide timer (video mode only).
    private var remoteVideoActive: Bool = false
    // [2026-05-26 remote-camera-off fix] When the remote peer MUTES their camera
    // (WhatsApp behaviour: keep the publication, just stop sending frames) the
    // SFU forwards a "muted" flag rather than unpublishing. We stash the still-
    // subscribed track here and swap the UI to the avatar placeholder, WITHOUT
    // nilling session.remoteVideoTrack (which would also tear down PiP / look
    // like the peer left). On unmute we re-bind this exact track and the video
    // comes back instantly — the call + audio never drop.
    private var remoteVideoMuted: Bool = false
    private var mutedRemoteVideoTrack: VideoTrack?
    // Scrim behind the controls when remote video is full-bleed, so the glass
    // buttons stay legible over arbitrary camera frames (mirrors JS
    // translucent gradient under the controls row).
    private var controlsScrim: UIView?
    // Auto-hide controls timer (video mode). Tap toggles; 5s of inactivity hides.
    private var controlsHideTimer: Timer?
    private var controlsHidden: Bool = false
    // Tap + pinch gestures installed once on first remote-video activation.
    private var videoTapGesture: UITapGestureRecognizer?
    private var remotePinchGesture: UIPinchGestureRecognizer?
    private var remoteZoomScale: CGFloat = 1.0

    // [WAVE 156 2026-05-22] Combine subscription that mirrors
    // session.status (@Published) into the UIKit statusLabel.
    private var statusObserver: AnyCancellable?
    private var dotsTimer: Timer?
    private var durationTimer: Timer?
    private var callConnectedAt: Date?
    private var dotCount = 0

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
    // [2026-10-23 callkit-native-buttons] Last mute state the native CallKit
    // screen knows about (nil = never reported → CallKit assumes unmuted).
    private var callKitMutedReported: Bool?
    // [2026-10-09 system-hold] CXSetHeldCallAction (system pill, "Hold &
    // Accept" on a GSM call, CallHoldResumer auto-resume) → hold UI + mic.
    private var systemHoldObserver: NSObjectProtocol?
    private var preHoldMicEnabled: Bool?
    // [2026-10-11 call-parity] Hold pauses a live camera too; restored on resume.
    private var preHoldCamEnabled: Bool = false
    // [2026-10-11 call-parity] The PEER put the call on hold ({type:"hold"}).
    private var peerOnHold: Bool = false
    // [2026-10-11 full-hd] WhatsApp "Conexão fraca" pill (debounced).
    private var localWeak = false
    private var peerWeak = false
    private var localWeakWork: DispatchWorkItem?
    private var peerWeakWork: DispatchWorkItem?
    private weak var weakPill: UIView?
    // [2026-10-11 call-parity] Outgoing call refused (declined/busy/unavailable):
    // showing the label ~1.5 s with a busy tone before dismissing.
    private var remoteRefusalActive: Bool = false
    private var busyTonePlayer: AVAudioPlayer?

    // [Wave WhatsApp parity, 2026-05-20 gap B5 iOS] Listen for AVAudioSession
    // interruptions (Siri, alarm, PSTN call) and recover the mic after the
    // interruption ends. Without this, post-Siri the user's mic stays
    // muted-by-iOS even though our LK track says it's enabled.
    private var avInterruptionObserver: NSObjectProtocol?

    // [2026-06-12 outgoing-mic-silence fix] Listen for CallKit's
    // provider:didActivate (re-posted by both provider delegates as
    // ExpoCallKitAudioSessionActivated). On OUTGOING calls the LK mic track
    // frequently gets captured BEFORE CallKit activates the AVAudioSession
    // (Room.connect + setMicrophone race ahead of didActivate) — a track
    // captured from an inactive session produces pure silence and never
    // self-heals ("quando EU ligo ela não me escuta"). The incoming path
    // never hits this because the VC presents after CXAnswer fulfils and the
    // system activates the session before the publish lands. Cleared in
    // deinit.
    private var audioActivatedObserver: NSObjectProtocol?

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

    // [2026-10-14 group-ui] 1:1 → GRID once a 3rd person is in (or being rung
    // into) the call — same SwiftUI grid as the group screen (GroupGridView):
    // 2 stacked, 3-4 in 2×2, 5-9 in 3 columns, 10+ scrolls; name + mic-muted
    // per tile, white ring on whoever speaks, own tile for a screen share,
    // "Tocando…" tiles. The 1:1 call logic (Room, CallKit, ringback, PiP,
    // hangup) is untouched — the grid only REPLACES the 1:1 visuals.
    private let gridSession = GroupCallSessionState(participants: [], status: "", micEnabled: true, camEnabled: false, speakerOn: false)
    private var gridHost: UIHostingController<GroupGridView>?
    private var gridHeaderLabel: UILabel?
    private var gridHeaderTimer: Timer?
    private var gridActive = false
    /// First-seen order of remote identities (stable tiles).
    private var gridOrder: [String] = []
    private var gridSpeaking: Set<String> = []
    private var gridQuality: [String: Int] = [:]
    /// bare email → name of people being rung INTO this call (picker, or present
    /// without media = ring preconnect). Cleared on media / leave / decline / 60 s.
    private var gridRinging: [String: String] = [:]
    /// bare email → display name learned from the picker.
    private var gridNames: [String: String] = [:]
    /// Identities that had media ("entrou" said) → "saiu" on leave.
    private var gridAnnounced: Set<String> = []
    private var gridPeopleCount: Int = 0
    private var gridRebuildPending = false
    private weak var gridToastView: UIView?
    private var gridToastWork: DispatchWorkItem?
    private var gridDeclineObserver: NSObjectProtocol?

    // [2026-10-12 peer-gone] 1:1 parity with Android CallActivity
    // (PEER_GONE_GRACE_MS): when the only remote leaves the SFU after media
    // flowed, show "Reconectando…" and end the call if nobody is back in 15 s.
    // Before, iOS never ended on peer-leave — the call ended only via WS
    // call_end, so a peer whose end frame was lost (hub BLOCKED "declined
    // after accepted", killed app) left this side alone in a silent call for
    // 16–25 s (call_1791817916407_zb2unnfa0, call_1791581586090_6zok4m0f3,
    // call_1791692518038_sm6ld6796).
    private var peerGoneWork: DispatchWorkItem?
    private var peerGoneRearms = 0
    // [2026-10-18 call-resilience] Was a fixed 15 s; WhatsApp waits ~30 s for a
    // peer in an elevator/tunnel. Flag `peer_grace_s` (master off → 15 s).
    private static var peerGoneGraceSeconds: Double { CallResilience.flags().peerGraceS }
    // [2026-10-18 call-resilience] Reconnect tone + trail diag + hold cap, and
    // camera auto-pause on a very poor uplink (CallResilience.swift).
    private var reconnectGuard: CallReconnectGuard?
    private var videoAutoPause: CallVideoAutoPause?
    // [2026-10-19 chamada-queda] call_1792442467735_42a0dhkwd: Wi-Fi do caller
    // caiu ~40 s; o SFU fechou o participante (PEER_CONNECTION_DISCONNECTED) e
    // o SDK 2.0.18 seguiu tentando RESUME ("could not restart participant")
    // com a tela em "Conectado" (o quick reconnect não muda connectionState) —
    // o usuário desligou. Agora: rejoin com token novo quando o SDK desiste,
    // watchdog de áudio parado e ICE restart na troca de rede.
    private var appRejoinActive = false
    private var appRejoinEpisodes = 0
    private var appRejoinWake = false
    private var pathWatcher: CallPathWatcher?
    private var stallTimer: Timer?
    private var stallLastPackets: UInt64 = 0
    private var stallLastTrackSid: String = ""
    private var stallSince: Date?
    private var stallActive = false
    private var stallQuickKicked = false
    private var stallFullKicked = false
    private var lastPathRestartAt: Date?
    private var lastStallFullAt: Date?

    // [2026-10-12 deinit-guard] Live CallViewController instances (weak). A
    // duplicate VC for the same call (safety-net re-present, redial while the
    // previous screen is still up) adopts the SAME NativeCallRoom Room; when
    // the stale twin deallocates, its deinit must not disconnect the Room the
    // live VC is using (call_1791817895316_lkdicey1a: caller left the room
    // 208 ms after media connected, CLIENT_REQUEST_LEAVE right after
    // native_ios_call_close_deinit_teardown; call_1791758720473_8mf5y1m8b:
    // callee's room torn down at Accept). Main-thread only.
    private static let liveInstances = NSHashTable<CallViewController>.weakObjects()

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

    // [2026-10-03 PRIVACY ring-leak fix] OUTGOING calls must NOT publish the
    // mic into the SFU until the callee has genuinely answered. The callee's
    // VoIP-push preconnectRoom joins the room subscribe-only DURING the ring,
    // so a caller mic published at connect time was audible to the callee
    // before Accept. The gate opens on the first real post-answer signal:
    // WS call_accepted (CallKitCallAnsweredRemote) OR the first remote track
    // we subscribe (the callee publishes nothing until it answers). Incoming
    // VCs are unaffected (isOutgoing == false => never gated).
    private var outgoingMicGateOpen: Bool = false

    // [2026-10-06 native-only outgoing] Native is the ONLY caller UI on iOS now
    // (chat-conversation no longer pushes /call.js when the build reports
    // supportsNativeOnlyOutgoing). Everything /call.js used to do for the
    // caller lives here: state text Chamando → Conectando → Conectado+timer,
    // 45s no-answer timeout, terminal status wording on remote end, earpiece
    // re-assert when remote audio starts. See also LKAudioSessionCallKitBridge
    // (audio unit gated on CallKit didActivate — the actual audio fix).
    private var statusDotsBase: String = "Conectando"
    private var outgoingRingTimer: DispatchWorkItem?
    private var outgoingConnectFallbackTimer: DispatchWorkItem?
    private var speakerTouchedByUser: Bool = false
    private var remoteEndObserver: NSObjectProtocol?
    /// [2026-10-15 chamadas-dnd] Caller: relé `call_peer_status` (callee com
    /// Foco/Não Perturbe — o toque não apareceu) → "Não perturbe ativo".
    private var peerStatusObserver: NSObjectProtocol?
    private var peerDndActive: Bool = false
    /// [2026-10-09 p2p-ios] P2PCallBridge.stateChangedNotification.
    private var p2pObserver: NSObjectProtocol?
    /// [2026-10-07 audio-route] AudioRouter.routeDidChangeNotification → keeps
    /// the "Alto-falante" button in sync with the REAL output (AirPods
    /// connect, BT drop, policy re-apply), not just the last tap.
    private var audioRouteObserver: NSObjectProtocol?
    private static let kOutgoingRingTimeoutSeconds: Int = 45
    private static let kTerminalStatuses: Set<String> = [
        "Encerrada", "Recusada", "Ocupado", "Sem resposta",
        "Atendida em outro dispositivo", "Desconectado", "Erro",
        "Não foi possível conectar", // [2026-10-10 call-states]
    ]
    /// [2026-10-11 call-parity] Terminal check incl. the localized refusal labels.
    private static func isTerminalStatus(_ s: String) -> Bool {
        if kTerminalStatuses.contains(s) { return true }
        return [CallStrings.s("declined"), CallStrings.s("busy"),
                CallStrings.s("unavailable"), CallStrings.s("ended"),
                CallResilience.text("connectionLost", lang: GroupCallStrings.lang)].contains(s) // [2026-10-18 call-resilience]
    }
    /// [2026-10-11 call-parity] Internal status literals are pt-BR (the state
    /// machine compares them); the label shows the app language.
    fileprivate static func displayStatus(_ s: String) -> String {
        switch s {
        case "Chamando…", "Chamando": return CallStrings.s("calling")
        case "Tocando…", "Tocando": return CallStrings.s("ringing")
        case "Conectando…", "Conectando": return CallStrings.s("connecting")
        case "Reconectando…", "Reconectando": return CallStrings.s("reconnecting")
        case "Conectado": return CallStrings.s("connected")
        case "Recusada": return CallStrings.s("declined")
        case "Ocupado": return CallStrings.s("busy")
        case "Encerrada": return CallStrings.s("ended")
        case "Sem resposta": return CallStrings.s("noAnswer")
        default: return s
        }
    }
    private static func dotsBase(_ s: String) -> String {
        var t = displayStatus(s)
        while t.hasSuffix("…") || t.hasSuffix(".") { t.removeLast() }
        return t
    }

    // MARK: - [2026-10-12 peer-gone] 1:1 peer left the SFU

    /// Last remote left the Room after media flowed (1:1). Not a hangup — a
    /// real hangup arrives as WS call_end / LK data `call_end` and ends us
    /// immediately. Give the peer `peerGoneGraceSeconds` to come back
    /// (network switch, NEGOTIATE_FAILED, full reconnect); otherwise end.
    private func startPeerGoneGrace(identity: String) {
        guard peerGoneWork == nil, !didHangup else { return }
        guard !session.isGroup, callConnectedAt != nil else { return }
        guard !P2PCallBridge.ownsMedia(callId) else { return }
        guard (room?.remoteParticipants.isEmpty ?? false) else { return }
        let who = identity.components(separatedBy: "#").first ?? ""
        nativeCallDiag("peer_left_grace", callId, "identity=\(who) t=\(Int(Self.peerGoneGraceSeconds))s")
        session.isReconnecting = true
        session.status = "Reconectando..."
        schedulePeerGoneTimeout()
    }

    private func schedulePeerGoneTimeout() {
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.peerGoneWork = nil
            guard !self.didHangup else { return }
            let remotes = self.room?.remoteParticipants.count ?? 0
            if remotes > 0 {
                self.restoreAfterPeerBack(reason: "timer_peer_present")
                return
            }
            // WE are the ones offline (our Room is reconnecting): the peer's
            // absence says nothing yet — LiveKit's own reconnect decides
            // (didDisconnectWithError ends the call if it gives up).
            // [2026-10-19 chamada-queda] …idem durante o nosso rejoin com token
            // novo (Room .disconnected entre tentativas; o hold cap decide).
            if self.appRejoinActive, self.peerGoneRearms < 4 {
                self.peerGoneRearms += 1
                nativeCallDiag("peer_left_grace_rearm", self.callId, "lk=app_rejoin n=\(self.peerGoneRearms)")
                self.schedulePeerGoneTimeout()
                return
            }
            if let r = self.room, r.connectionState == .reconnecting || r.connectionState == .connecting,
               self.peerGoneRearms < 3 {
                self.peerGoneRearms += 1
                nativeCallDiag("peer_left_grace_rearm", self.callId, "lk=\(NativeCallRoom.stateName(r.connectionState)) n=\(self.peerGoneRearms)")
                self.schedulePeerGoneTimeout()
                return
            }
            nativeCallDiag("peer_gone_timeout", self.callId, "remotes=0")
            self.endForConnectionLoss(reason: "peer_left")
        }
        peerGoneWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.peerGoneGraceSeconds, execute: work)
    }

    /// Peer rejoined inside the grace window (or was back when it expired).
    private func restoreAfterPeerBack(reason: String) {
        let wasPending = peerGoneWork != nil
        peerGoneWork?.cancel(); peerGoneWork = nil
        peerGoneRearms = 0
        guard !didHangup, session.status.hasPrefix("Reconectando") else { return }
        if wasPending || reason.hasPrefix("timer") {
            nativeCallDiag("peer_rejoined", callId, reason)
        }
        // Our own Room may still be reconnecting — its delegate restores then.
        if let r = room, r.connectionState == .reconnecting { return }
        session.isReconnecting = false
        session.status = (callConnectedAt != nil) ? "Conectado" : statusDotsBase
    }

    // MARK: - [2026-10-18 call-resilience] reconnect guard / video auto-pause

    /// Main thread (viewDidLoad). Kill switch: App Group `call_res_flags`
    /// {"enabled":false} → nothing installed (legacy behaviour).
    private func installCallResilience() {
        let f = CallResilience.flags()
        guard f.enabled else { return }
        let cid = callId
        let g = CallReconnectGuard(
            flags: f,
            isReconnecting: { [weak self] in
                guard let self = self, !self.didHangup else { return false }
                return self.session.isReconnecting
            },
            mediaConnected: { [weak self] in
                guard let self = self else { return false }
                return self.callConnectedAt != nil && !self.session.isGroup
            },
            onGiveUp: { [weak self] in
                self?.reconnectHoldCapReached()
            },
            diag: { ev, detail in nativeCallDiag(ev, cid, detail) }
        )
        reconnectGuard = g
        g.start()
        installConnectionWatch(f) // [2026-10-19 chamada-queda]
        if f.videoAutoPause {
            let vp = CallVideoAutoPause(
                flags: f,
                cameraWanted: { [weak self] in
                    guard let self = self, !self.didHangup else { return false }
                    return self.session.camEnabled
                },
                eligible: { [weak self] in
                    guard let self = self, self.session.localVideoTrack != nil else { return false }
                    if self.session.isGroup || self.gridActive || self.screenSharing { return false }
                    if self.session.onHold || self.peerOnHold || self.session.isReconnecting { return false }
                    return self.callConnectedAt != nil
                },
                pause: { [weak self] in
                    guard let self = self, let t = self.session.localVideoTrack else { return }
                    Task { try? await t.mute() }
                },
                resume: { [weak self] in
                    guard let self = self, !self.didHangup, self.session.camEnabled,
                          let t = self.session.localVideoTrack else { return }
                    Task { try? await t.unmute() }
                },
                changed: { [weak self] in
                    self?.updateWeakConnectionPill()
                },
                diag: { ev, detail in nativeCallDiag(ev, cid, detail) }
            )
            videoAutoPause = vp
            vp.start()
        }
    }

    private func stopCallResilience() {
        reconnectGuard?.stop()
        reconnectGuard = nil
        videoAutoPause?.stop()
        // [2026-10-19 chamada-queda]
        pathWatcher?.stop()
        pathWatcher = nil
        stallTimer?.invalidate()
        stallTimer = nil
        appRejoinActive = false
    }

    /// "Reconectando…" for `hold_cap_s` straight. A Room that is connected
    /// with the peer present means the flag is stale (no frozen screen): clear
    /// it; otherwise the connection is really gone → end.
    private func reconnectHoldCapReached() {
        // [2026-10-19 chamada-queda] Áudio parado (stallActive) com a Room
        // "connected" = quick reconnect invisível do SDK → NÃO é flag velho.
        if !stallActive, !appRejoinActive, let r = room, r.connectionState == .connected, !r.remoteParticipants.isEmpty,
           !P2PCallBridge.ownsMedia(callId) {
            nativeCallDiag("call_reconnect_stale", callId, "remotes=\(r.remoteParticipants.count)")
            peerGoneWork?.cancel(); peerGoneWork = nil
            peerGoneRearms = 0
            session.isReconnecting = false
            session.status = (callConnectedAt != nil) ? "Conectado" : statusDotsBase
            return
        }
        endForConnectionLoss(reason: "reconnect_timeout")
    }

    /// Ends the call because the connection is gone (hold cap / peer never
    /// came back): WhatsApp "Chamada encerrada — conexão perdida".
    private func endForConnectionLoss(reason: String) {
        guard !didHangup else { return }
        let f = CallResilience.flags()
        let txt = CallResilience.text("connectionLost", lang: GroupCallStrings.lang)
        nativeCallDiag("call_end_connection_lost", callId, "reason=\(reason)")
        handleHangup(reason: reason, statusText: f.endNotice ? txt : "Encerrada", sendCallEnd: true)
        if f.endNotice { CallEndNotice.show(txt, delay: 0.6) }
    }

    // MARK: - [2026-10-19 chamada-queda] rejoin / stall watch / path restart

    /// Main thread (installCallResilience). Path watcher + 1 Hz stall watch.
    private func installConnectionWatch(_ f: CallResilience.Flags) {
        if f.pathRestart, pathWatcher == nil {
            let w = CallPathWatcher { [weak self] why in
                self?.networkPathChanged(why: why)
            }
            pathWatcher = w
            w.start()
        }
        if f.stallWatch, stallTimer == nil {
            let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
                self?.stallTick()
            }
            RunLoop.main.add(t, forMode: .common)
            stallTimer = t
        }
    }

    /// Rede mudou (Wi-Fi ↔ celular / voltou). Main thread.
    private func networkPathChanged(why: String) {
        guard !didHangup else { return }
        appRejoinWake = true // o loop do rejoin tenta já, sem esperar o intervalo
        guard callConnectedAt != nil, !P2PCallBridge.ownsMedia(callId), !appRejoinActive,
              let r = room, r.connectionState == .connected else { return }
        if let last = lastPathRestartAt, Date().timeIntervalSince(last) < 3 { return }
        lastPathRestartAt = Date()
        let cid = callId
        nativeCallDiag("path_ice_restart", cid, "why=\(why)")
        // ICE restart + resume do sinal AGORA (o SDK só reagiria quando o ICE
        // desse "disconnected", ~5–15 s depois). Já reconectando → invalidState
        // (ignorado): o SDK já está nisso.
        Task.detached {
            do { try await r.debug_simulate(scenario: .quickReconnect) }
            catch { nativeCallDiag("path_ice_restart_skip", cid, "err=\(error)") }
        }
    }

    /// 1 Hz. Áudio do par parado com a Room "connected" (o quick reconnect do
    /// SDK 2.0.18 não muda connectionState): stall_s → "Reconectando…" + ICE
    /// restart; stall_full_s → FULL reconnect (republica as tracks).
    /// Sai do estado "áudio parado". `restore` = devolve "Conectado" se a
    /// Room está de pé, sem grace do par nem rejoin em curso.
    private func clearStall(why: String) {
        stallSince = nil
        stallQuickKicked = false
        stallFullKicked = false
        guard stallActive else { return }
        stallActive = false
        nativeCallDiag("media_stall_end", callId, "why=\(why)")
        if !didHangup, !appRejoinActive, session.isReconnecting, peerGoneWork == nil,
           room?.connectionState == .connected {
            session.isReconnecting = false
            session.status = "Conectado"
        }
    }

    private func stallTick() {
        guard !didHangup, !appRejoinActive, callConnectedAt != nil, !P2PCallBridge.ownsMedia(callId),
              !session.onHold, !peerOnHold, let r = room, r.connectionState == .connected else {
            clearStall(why: "ineligible")
            return
        }
        // 1:1 apenas (grade = vários pares; cada um com a sua rede).
        guard r.remoteParticipants.count == 1, let rp = r.remoteParticipants.values.first,
              let pub = rp.audioTracks.first(where: { $0.source == .microphone }) ?? rp.audioTracks.first,
              !pub.isMuted, let track = pub.track as? RemoteAudioTrack,
              let inbound = track.statistics?.inboundRtpStream.first,
              let pkts = inbound.packetsReceived else {
            clearStall(why: "no_track")
            return
        }
        let sid = "\(pub.sid)"
        if sid != stallLastTrackSid || pkts != stallLastPackets {
            // Pacotes chegando (DTX manda ~2,5/s mesmo em silêncio).
            stallLastTrackSid = sid
            stallLastPackets = pkts
            clearStall(why: "packets")
            return
        }
        let now = Date()
        guard let since = stallSince else { stallSince = now; return }
        let f = CallResilience.flags()
        let stalled = now.timeIntervalSince(since) + 1.0 // +1: o 1º tick congelado já é 1 s
        if stalled >= f.stallS && !stallActive {
            stallActive = true
            nativeCallDiag("media_stall", callId, "s=\(Int(stalled)) peer_q=\(rp.connectionQuality) my_q=\(r.localParticipant.connectionQuality)")
            session.isReconnecting = true
            session.status = "Reconectando..."
        }
        let cid = callId
        if stallActive && !stallQuickKicked {
            stallQuickKicked = true
            Task.detached {
                do { try await r.debug_simulate(scenario: .quickReconnect) }
                catch { nativeCallDiag("media_stall_quick_skip", cid, "err=\(error)") }
            }
        }
        if stalled >= f.stallFullS && !stallFullKicked
            && (lastStallFullAt.map { now.timeIntervalSince($0) > 45 } ?? true) { // par morto: não refaz o join a cada 12 s
            stallFullKicked = true
            lastStallFullAt = now
            nativeCallDiag("media_stall_full", cid, "s=\(Int(stalled))")
            // SDK ocioso → FULL reconnect dele (novo join, republica tracks).
            // Já reconectando (quick em curso) → invalidState: com 3 tentativas
            // (lk_fast_reconnect) o FULL dele vem em seguida, e se desistir o
            // didDisconnectWithError entra no rejoin com token novo.
            Task.detached {
                do { try await r.debug_simulate(scenario: .fullReconnect) }
                catch { nativeCallDiag("media_stall_full_skip", cid, "err=\(error)") }
            }
        }
    }

    /// LiveKit desistiu (erro de rede) numa ligação com mídia → em vez de
    /// encerrar: "Reconectando…" e REJOIN na mesma sala com token NOVO, em
    /// loop até o hold cap (CallReconnectGuard encerra com "conexão perdida").
    /// Main thread. false = não aplicável (segue o encerramento antigo).
    private func startAppRejoin(room r: Room, why: String) -> Bool {
        if appRejoinActive { return true }
        let f = CallResilience.flags()
        guard f.appRejoin, !didHangup, callConnectedAt != nil else { return false }
        if NativeCallRoom.shared.currentRoom() == nil {
            NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId, url: lkUrl, token: lkToken)
        }
        guard NativeCallRoom.shared.currentRoom() === r else { return false }
        appRejoinActive = true
        appRejoinEpisodes += 1
        stallActive = false
        stallSince = nil
        let n = appRejoinEpisodes
        let t0 = Date()
        session.isReconnecting = true
        session.status = "Reconectando..."
        nativeCallDiag("app_rejoin_start", callId, "why=\(why) n=\(n)")
        let cid = callId
        let budget: Double = f.holdCapS > 0 ? f.holdCapS + 5 : 75
        Task { [weak self] in
            var attempt = 0
            while true {
                attempt += 1
                let go: Bool = await MainActor.run {
                    guard let self = self else { return false }
                    self.appRejoinWake = false
                    return self.appRejoinActive && !self.didHangup && self.room === r
                }
                if !go { return }
                let a = attempt
                if Date().timeIntervalSince(t0) > budget {
                    await MainActor.run {
                        guard let self = self, self.appRejoinActive else { return }
                        self.appRejoinActive = false
                        nativeCallDiag("app_rejoin_giveup", cid, "n=\(n) attempts=\(a - 1)")
                        self.endForConnectionLoss(reason: "app_rejoin_timeout")
                    }
                    return
                }
                let task: Task<Bool, Never>? = await MainActor.run {
                    guard NativeCallRoom.shared.currentRoom() === r else { return nil }
                    return NativeCallRoom.shared.rejoinIfDead(callId: cid, reason: "app_rejoin_\(a)", freshFirst: true)
                }
                var ok = false
                if let task = task { ok = await task.value }
                if ok || r.connectionState == .connected {
                    await MainActor.run { self?.appRejoinSucceeded(room: r, n: n, attempt: a, t0: t0) }
                    return
                }
                // Intervalo curto; troca de rede (appRejoinWake) adianta.
                for _ in 0..<6 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    let wake: Bool = await MainActor.run { self?.appRejoinWake ?? true }
                    if wake { break }
                }
            }
        }
        return true
    }

    /// Main thread. Room de volta → republica mic (respeitando o mudo) e câmera.
    private func appRejoinSucceeded(room r: Room, n: Int, attempt: Int, t0: Date) {
        guard appRejoinActive else { return }
        appRejoinActive = false
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        nativeCallDiag("app_rejoin_ok", callId, "n=\(n) attempt=\(attempt) ms=\(ms)")
        guard !didHangup else { return }
        if peerGoneWork == nil || !r.remoteParticipants.isEmpty {
            session.isReconnecting = false
            session.status = "Conectado"
        }
        // Voltamos e o par não está na sala (saiu enquanto estávamos fora):
        // nenhum participantDidDisconnect vai chegar → arma o grace do par.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self = self, !self.didHangup, self.room === r,
                  r.connectionState == .connected, r.remoteParticipants.isEmpty else { return }
            self.startPeerGoneGrace(identity: "after_rejoin")
        }
        let micOn = session.micEnabled
        let camOn = session.camEnabled
        let p2p = P2PCallBridge.ownsMedia(callId)
        Task { [weak self] in
            guard let self = self else { return }
            if micOn && !p2p {
                do {
                    let pub = try await CallE2EE.gated(r, self.callId, "app_rejoin_mic").setMicrophone(
                        enabled: true, captureOptions: Self.defaultAudioCaptureOptions())
                    if let t = pub?.track as? LocalAudioTrack {
                        await MainActor.run { self.localAudioTrackRef = t }
                    }
                } catch {
                    nativeCallDiag("app_rejoin_mic_failed", self.callId, "\(error)")
                }
            }
            if camOn {
                do {
                    let pos = await MainActor.run { self.currentCameraPosition }
                    let pub = try await CallE2EE.gated(r, self.callId, "app_rejoin_cam").setCamera(
                        enabled: true,
                        captureOptions: Self.defaultCameraCaptureOptions(position: pos),
                        publishOptions: Self.defaultVideoPublishOptions())
                    if let t = pub?.track as? LocalVideoTrack {
                        await MainActor.run {
                            self.session.localVideoTrack = t
                            self.applyLocalVideoTrack(t)
                        }
                    }
                } catch {
                    nativeCallDiag("app_rejoin_cam_failed", self.callId, "\(error)")
                }
            }
        }
    }

    /// LiveKit `didDisconnectWithError` → localized "connection lost" text when
    /// the error is a network-class failure on a call whose media flowed;
    /// nil for our own leave, kicks, room deleted, duplicate identity.
    /// [2026-10-19 chamada-queda] Queda de rede/servidor recuperável (não é
    /// nossa saída, expulsão, sala apagada nem identidade duplicada).
    private static func isRecoverableDrop(_ e: LiveKitError) -> Bool {
        switch e.type {
        case .cancelled, .duplicateIdentity, .participantRemoved, .roomDeleted:
            return false
        default:
            return true
        }
    }

    private static func connectionLostText(error: LiveKitError?, mediaFlowed: Bool) -> String? {
        guard mediaFlowed, let e = error, CallResilience.flags().endNotice else { return nil }
        switch e.type {
        case .cancelled, .duplicateIdentity, .participantRemoved, .roomDeleted:
            return nil
        default:
            return CallResilience.text("connectionLost", lang: GroupCallStrings.lang)
        }
    }

    // MARK: - [2026-10-18 calls-data] "Sem conexão — tentando…"

    private var preconnSlowObserver: NSObjectProtocol?
    private var preconnSlowShown = false

    /// Answered incoming call on an adopted Room that is not connected yet:
    /// after `preconn_retry_s` (or at once when the preconnect check already
    /// saw it stuck) say so instead of a silent "Conectando…"; back to
    /// "Conectando…" as soon as the Room connects. Never touches the Room.
    private func startPreconnSlowWatch() {
        let delay = CallResilience.flags().preconnRetryS
        guard delay > 0, preconnSlowObserver == nil else { return }
        let cid = callId
        preconnSlowObserver = NotificationCenter.default.addObserver(
            forName: CallViewController.preconnectSlowNotification, object: nil, queue: .main
        ) { [weak self] n in
            guard let self = self, (n.userInfo?["callId"] as? String) == cid else { return }
            self.checkPreconnSlow(source: "preconnect_check")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.checkPreconnSlow(source: "callvc_timer")
        }
    }

    private func checkPreconnSlow(source: String) {
        guard !didHangup, callConnectedAt == nil, session.status != "Conectado" else { return stopPreconnSlowWatch() }
        guard let r = room else { return }
        if r.connectionState == .connected {
            if preconnSlowShown {
                preconnSlowShown = false
                statusDotsBase = "Conectando"
                nativeCallDiag("no_conn_retrying_cleared", callId, "src=\(source)")
            }
            return stopPreconnSlowWatch()
        }
        if !preconnSlowShown {
            preconnSlowShown = true
            statusDotsBase = CallResilience.text("noConnRetrying", lang: GroupCallStrings.lang)
            if let lbl = view.viewWithTag(9001) as? UILabel {
                lbl.text = CallViewController.dotsBase(statusDotsBase)
            }
            nativeCallDiag("no_conn_retrying_shown", callId,
                           "src=\(source) lk=\(NativeCallRoom.stateName(r.connectionState))")
        }
        // Poll until connected / media / hangup (the 8 s / 25 s watchdog still decides).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.checkPreconnSlow(source: "poll")
        }
    }

    private func stopPreconnSlowWatch() {
        if let o = preconnSlowObserver {
            NotificationCenter.default.removeObserver(o)
            preconnSlowObserver = nil
        }
    }

    /// Single place that commits "Conectado": opens the caller gate, stops
    /// ringback, starts the duration timer (via the statusObserver sink) and
    /// tells CallKit the outgoing call connected. Idempotent.
    private func markCallConnected(reason: String) {
        cancelOutgoingConnectFallback()
        if isOutgoing { openOutgoingMicGate(reason: "connected_" + reason) }
        stopRingbackTone(reason: "connected_" + reason)
        guard session.status != "Conectado" else { return }
        session.status = "Conectado"
        nativeCallDiag("call_connected", callId, reason)
        // [video-quality 2026-10-06] t+8s / t+45s "video_quality" beacons.
        scheduleVideoQualityDiag()
        if isOutgoing, let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId) {
            if let p = ExpoCallKitModule.sharedProvider {
                p.reportOutgoingCall(with: uuid, connectedAt: Date())
            } else if let p = VoipPushAppDelegateSubscriber.earlyProvider {
                p.reportOutgoingCall(with: uuid, connectedAt: Date())
            }
        }
    }

    /// [2026-10-10 call-states] Post-answer CONNECT WATCHDOG (was the 5s/6s
    /// "flip to Conectado anyway" fallback). WhatsApp rule, identical on
    /// Android CallActivity and JS call.js: "Conectado" + timer ONLY on media
    /// truth (didSubscribeTrack / P2P connected) — never on accept or peer
    /// presence alone. Armed after the answer (caller: WS call_accepted;
    /// callee: VC up after Accept). `seconds` (8) without media → resubscribe
    /// nudge; +17s (25s total) → if the peer is genuinely in the room (answered
    /// but mic muted/denied → nothing to subscribe) commit "Conectado" rather
    /// than kill a live call; otherwise "Não foi possível conectar" +
    /// call_end{reason:failed}. Stored in outgoingConnectFallbackTimer so every
    /// existing cancelOutgoingConnectFallback() site also cancels it.
    private func scheduleOutgoingConnectFallback(reason: String, seconds: Double) {
        guard !didHangup, session.status != "Conectado", outgoingConnectFallbackTimer == nil else { return }
        // Caller: only after the real answer (the ring has its own 45s timer).
        if isOutgoing && !outgoingMicGateOpen { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.outgoingConnectFallbackTimer = nil
            guard !self.didHangup, self.session.status != "Conectado" else { return }
            // [2026-10-10] Founder: "tá aparecendo conectado mesmo se a pessoa
            // não atendeu?" — SIM: o callee pré-conecta (só assinatura) DURANTE
            // o toque, então "peer presente" virava "Conectado" em 6s com o
            // celular dela ainda tocando (call_1791675346907: callee 'missed',
            // caller 'call_connected participant_present_6s'). Agora o fallback
            // só confirma se o atendimento chegou (WS call_accepted abriu o
            // gate) E o par está na sala; mídia real (didSubscribe) segue sendo
            // o caminho principal.
            // [2026-10-10 call-states] …and even then only after 25s (the
            // muted-mic case); before that we only nudge subscriptions.
            let peerPresent = (self.room?.remoteParticipants.isEmpty == false)
            let lkState = self.room.map { NativeCallRoom.stateName($0.connectionState) } ?? "no_room"
            nativeCallDiag("connect_watchdog_no_media", self.callId,
                           "reason=\(reason) t=\(Int(seconds))s peer=\(peerPresent) accepted=\(self.outgoingMicGateOpen) p2p=\(P2PCallBridge.ownsMedia(self.callId)) lk=\(lkState)")
            self.nudgeRemoteSubscriptions()
            // [2026-10-11 publisher-nil] Answered incoming call whose (adopted
            // ring-window) Room is DEAD: it dropped before this VC attached as
            // RoomDelegate, so no didDisconnect ever reached us and nothing
            // would bring it back (call_1791692112285_b4n0z80v9: callee left
            // the room on answer, caller watchdog peer=false until 25 s
            // "Não foi possível conectar"). Rejoin the same Room, then
            // republish the mic (mute-aware) — the 17 s fail timer below still
            // ends the call if the rejoin does not bring media.
            self.rejoinIncomingRoomIfDead(reason: "watchdog_\(Int(seconds))s")
            let fail = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.outgoingConnectFallbackTimer = nil
                guard !self.didHangup, self.session.status != "Conectado" else { return }
                let present = (self.room?.remoteParticipants.isEmpty == false)
                    && (self.room?.connectionState == .connected)
                    && (!self.isOutgoing || self.outgoingMicGateOpen)
                if present {
                    nativeCallDiag("connect_watchdog_present_no_media", self.callId, reason)
                    self.markCallConnected(reason: "present_no_media_25s")
                } else {
                    self.failConnect(reason: reason)
                }
            }
            self.outgoingConnectFallbackTimer = fail
            DispatchQueue.main.asyncAfter(deadline: .now() + 17.0, execute: fail)
        }
        outgoingConnectFallbackTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// [2026-10-11 publisher-nil] See the watchdog above. Incoming only (an
    /// outgoing VC owns its Room from the start and gets didDisconnect).
    private func rejoinIncomingRoomIfDead(reason: String) {
        guard !isOutgoing, !didHangup, let r = room, r.connectionState == .disconnected else { return }
        if NativeCallRoom.shared.currentRoom() == nil {
            // The singleton was cleared under us (e.g. ring-window connect
            // failure path) — re-own the VC's Room so it can be rejoined.
            NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId, url: lkUrl, token: lkToken)
        }
        guard NativeCallRoom.shared.currentRoom() === r,
              let rejoin = NativeCallRoom.shared.rejoinIfDead(callId: callId, reason: reason) else { return }
        Task { [weak self] in
            let ok = await rejoin.value
            guard ok, let self = self else { return }
            let micTask: Task<LocalTrackPublication?, Never>? = await MainActor.run {
                guard !self.didHangup, self.session.micEnabled, !P2PCallBridge.ownsMedia(self.callId) else { return nil }
                return NativeCallRoom.shared.ensureIncomingMicPublished(callId: self.callId, reason: "rejoin_\(reason)")
            }
            if let pub = await micTask?.value, let track = pub.track as? LocalAudioTrack {
                await MainActor.run { self.localAudioTrackRef = track }
            }
            // Video calls: the camera track died with the Room too.
            // [2026-10-15 cam-1-toque] Also a VOICE call upgraded to video
            // (camEnabled is now false by default on voice calls, so this
            // only republishes when the user really turned the camera on).
            do {
                let camOn: Bool = await MainActor.run { self.session.camEnabled }
                if camOn {
                    do {
                        let pub = try await CallE2EE.gated(r, self.callId, "rejoin_cam").setCamera(
                            enabled: true,
                            captureOptions: Self.defaultCameraCaptureOptions(position: self.currentCameraPosition),
                            publishOptions: Self.defaultVideoPublishOptions()
                        )
                        if let track = pub?.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.session.localVideoTrack = track
                                self.applyLocalVideoTrack(track)
                            }
                        }
                    } catch {
                        nativeCallDiag("rejoin_cam_publish_failed", self.callId, "\(error)")
                    }
                }
            }
        }
    }

    /// [2026-10-10 call-states] Cheap recovery for "answered but no media":
    /// (re)request every remote publication we are not subscribed to. LiveKit
    /// already runs its own ICE restart / resume on transport failure.
    private func nudgeRemoteSubscriptions() {
        guard let r = room else { return }
        for rp in r.remoteParticipants.values {
            for pub in rp.trackPublications.values {
                guard let rpub = pub as? RemoteTrackPublication, rpub.track == nil else { continue }
                Task { try? await rpub.set(subscribed: true) }
            }
        }
    }

    /// [2026-10-10 call-states] 25s after the answer with no media: tell the
    /// user, then end with the hub-relayed reason "failed".
    private func failConnect(reason: String) {
        guard !didHangup else { return }
        nativeCallDiag("connect_failed_no_media", callId, reason)
        stopRingbackTone(reason: "connect_failed")
        session.status = "Não foi possível conectar"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self, !self.didHangup, self.session.status != "Conectado" else { return }
            self.handleHangup(reason: "failed", statusText: "Não foi possível conectar")
        }
    }

    /// [2026-10-10 call-states] Caller: the callee's device is confirmed
    /// ringing (its subscribe-only preconnect joined the LK room). Upgrades
    /// "Chamando…" → "Tocando…" only; ringback keeps playing; NEVER connected.
    private func markPeerRinging(reason: String) {
        guard isOutgoing, !outgoingMicGateOpen, !didHangup, callConnectedAt == nil else { return }
        guard statusDotsBase == "Chamando" else { return }
        statusDotsBase = "Tocando"
        session.status = "Tocando"
        nativeCallDiag("outgoing_peer_ringing", callId, reason)
    }

    /// [2026-10-15 chamadas-dnd] Caller: o servidor repassa o status do
    /// aparelho do callee (CallSignalWs → ExpoCallKitPeerCallStatus).
    ///   dnd     → "Não perturbe ativo" (ringback continua; NÃO encerra; um
    ///             "Tocando" posterior via participant join não sobrescreve —
    ///             markPeerRinging só sai de "Chamando").
    ///   ringing → o callee abriu o app e o toque apareceu → "Tocando…".
    private func installPeerStatusObserver() {
        guard isOutgoing, peerStatusObserver == nil else { return }
        peerStatusObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitPeerCallStatus"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self, !self.didHangup else { return }
            guard (note.userInfo?["callId"] as? String) == self.callId else { return }
            guard !self.outgoingMicGateOpen, self.callConnectedAt == nil, !self.remoteRefusalActive else { return }
            let st = ((note.userInfo?["status"] as? String) ?? "").lowercased()
            if st == "dnd" {
                guard !self.peerDndActive else { return }
                self.peerDndActive = true
                let label = CallStrings.s("peerDnd")
                self.statusDotsBase = label
                self.session.status = label
                if let lbl = self.view.viewWithTag(9001) as? UILabel { lbl.text = label }
                nativeCallDiag("outgoing_peer_dnd", self.callId, (note.userInfo?["reason"] as? String) ?? "")
            } else if st == "ringing" {
                guard self.peerDndActive else { return }
                self.peerDndActive = false
                self.statusDotsBase = "Chamando"
                self.markPeerRinging(reason: "peer_status_ringing")
            }
        }
    }

    private func cancelOutgoingConnectFallback() {
        outgoingConnectFallbackTimer?.cancel()
        outgoingConnectFallbackTimer = nil
    }

    /// 45s no-answer timeout owned by the VC (the module's timer only reports
    /// `.unanswered` to CallKit and leaves this screen up — /call.js used to
    /// own the 60s JS timeout). Ends the call with "Sem resposta" and ships
    /// call_end{reason:timeout} so the hub cancels the callee's ring + push.
    private func scheduleOutgoingRingTimer() {
        guard isOutgoing, outgoingRingTimer == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.outgoingRingTimer = nil
            guard !self.didHangup, !self.outgoingMicGateOpen, self.session.status != "Conectado" else { return }
            NSLog("[CallVC] outgoing ring timeout \(Self.kOutgoingRingTimeoutSeconds)s — no answer callId=\(self.callId)")
            nativeCallDiag("outgoing_ring_timeout_vc", self.callId)
            self.handleHangup(reason: "timeout", statusText: "Sem resposta")
        }
        outgoingRingTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Self.kOutgoingRingTimeoutSeconds), execute: work)
    }

    private func cancelOutgoingRingTimer() {
        outgoingRingTimer?.cancel()
        outgoingRingTimer = nil
    }

    /// Terminal wording when the OTHER side ends the call (CallSignalWs posts
    /// ExpoCallKitNativeCallEnded with the hub's reason; the module then
    /// dismisses this VC). Previously the label stayed on "Chamando..." for the
    /// dismiss animation. Skipped when WE ended (handleHangup sets its own).
    private func installRemoteEndStatusObserver() {
        guard remoteEndObserver == nil else { return }
        remoteEndObserver = NotificationCenter.default.addObserver(
            forName: CallViewController.callEndedNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self, !self.didHangup else { return }
            let nid = (note.userInfo?["callId"] as? String) ?? ""
            guard nid == self.callId else { return }
            // [2026-10-11 call-parity] Refusal already on screen (module routed it).
            if self.remoteRefusalActive { return }
            let reason = ((note.userInfo?["reason"] as? String) ?? "").lowercased()
            let label: String
            switch reason {
            case "declined", "rejected", "call_declined":
                label = CallStrings.s("declined")
            case "busy":
                label = CallStrings.s("busy")
            case "unavailable", "offline":
                label = CallStrings.s("unavailable")
            case "timeout", "unanswered", "missed", "no_answer", "cancelled", "canceled":
                label = (self.isOutgoing && !self.outgoingMicGateOpen) ? "Sem resposta" : "Encerrada"
            case "answered_elsewhere":
                label = "Atendida em outro dispositivo"
            case "failed": // [2026-10-10 call-states] peer's 25s no-media watchdog
                label = "Não foi possível conectar"
            default:
                label = "Encerrada"
            }
            self.cancelOutgoingRingTimer()
            self.cancelOutgoingConnectFallback()
            self.stopRingbackTone(reason: "remote_end_" + reason)
            if self.session.status != label { self.session.status = label }
        }
    }

    private func openOutgoingMicGate(reason: String) {
        guard isOutgoing, !outgoingMicGateOpen else { return }
        outgoingMicGateOpen = true
        // [2026-10-06 native-only outgoing] Answered — the no-answer timer is moot.
        cancelOutgoingRingTimer()
        // [2026-10-10 call-states] …and so is the module's process-scope 45s
        // CallKit .unanswered timer (otherwise an answer at ~40s whose media
        // lands after 45s got the call killed as "unanswered").
        VoipPushAppDelegateSubscriber.cancelOutgoingTimeout(callId: callId)
        nativeCallDiag("outgoing_mic_gate_open", callId, reason)
        // [2026-10-15 cam-1-toque] Camera tapped ON while a voice call was
        // ringing → publish it now that the callee answered.
        if camOnAnswerPending {
            camOnAnswerPending = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self, !self.didHangup,
                      self.session.camEnabled, !self.isTogglingCamera else { return }
                self.isTogglingCamera = true
                self.applyCamEnabled(true)
            }
        }
        // [2026-10-09 p2p-ios] Ligação 1:1 de voz com P2P ligado: o P2P vira
        // dono da mídia e o Room LiveKit fica em espera quente (nada publicado).
        // Se o P2P cair, P2PCallBridge publica o mic nesse mesmo Room.
        if P2PCallBridge.startIfEligible(callId: callId, isCaller: true, hasVideo: hasVideo) {
            P2PCallBridge.setMicEnabled(callId: callId, session.micEnabled)
            nativeCallDiag("outgoing_media_p2p", callId, reason)
            return
        }
        guard let r = self.room else { return }
        // [2026-10-04 ring-leak, VIDEO] Publish the caller's camera on answer
        // too, gated the same as the mic. Done BEFORE the mic-enabled guard so a
        // muted-mic video call still shows the caller's camera after Accept.
        if self.hasVideo {
            // [2026-10-14 self-view] Was a single `try?` setCamera: any throw
            // (SFU log call_1791946803888_gfxpp5v5q: ICE reconnecting right at
            // the answer) left the CALLER with no camera at all — no self-view
            // (voip_diag video_quality cap=none) and the peer never saw him.
            // Now: publish the ringing preview track (or a fresh camera), 3
            // tries, diag on failure, bind the self-view directly.
            let preview = self.outgoingPreviewTrack
            Task { [weak self] in
                guard let self = self else { return }
                let captureOpts = Self.defaultCameraCaptureOptions(position: self.currentCameraPosition)
                let publishOpts = Self.defaultVideoPublishOptions()
                var lastError: Error?
                for attempt in 1...3 {
                    guard let r2 = self.room, !self.didHangup else { return }
                    // [2026-10-14 publish-wait] Answer can land while the Room is
                    // still joining / resuming → wait for .connected first.
                    if r2.connectionState != .connected {
                        let st = await RoomStateWaiter.wait(room: r2, timeout: 8.0)
                        if st != .connected {
                            lastError = NSError(domain: "ChatyyCallPublish", code: -1,
                                                userInfo: [NSLocalizedDescriptionKey: "not_connected lk=\(NativeCallRoom.stateName(st))"])
                            if st == .disconnected { break }
                            continue
                        }
                    }
                    do {
                        let pub: LocalTrackPublication?
                        if let preview = preview, attempt < 3 {
                            pub = try await CallE2EE.gated(r2, self.callId, "answer_cam_preview").publish(videoTrack: preview, options: publishOpts)
                        } else {
                            // Last try: drop the preview capturer (if any) and
                            // let LiveKit build a fresh camera track.
                            if let preview = preview, r2.localParticipant.localVideoTracks.first(where: { $0.track === preview }) == nil {
                                try? await preview.stop()
                            }
                            pub = try await CallE2EE.gated(r2, self.callId, "answer_cam").setCamera(enabled: true, captureOptions: captureOpts, publishOptions: publishOpts)
                        }
                        if let track = pub?.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.outgoingPreviewTrack = nil   // published (or replaced) — LK owns it now
                                self.session.localVideoTrack = track
                                self.applyLocalVideoTrack(track)
                            }
                            // Camera was switched off while ringing → keep it off.
                            let camOn: Bool = await MainActor.run { self.session.camEnabled }
                            if !camOn {
                                // Preview muted while ringing: publish restarted
                                // the capture → stop it again (unmute restarts).
                                if track.isMuted { try? await track.stop() } else { try? await track.mute() }
                            }
                            nativeCallDiag("outgoing_cam_published_on_answer", self.callId, "attempt=\(attempt) preview=\(preview != nil)")
                            print("[CallVC] outgoing camera published on answer (\(reason)) callId=\(self.callId)")
                            return
                        }
                        lastError = nil
                        break
                    } catch {
                        lastError = error
                        print("[CallVC] outgoing camera publish on answer failed (try \(attempt)): \(error)")
                        try? await Task.sleep(nanoseconds: 700_000_000)
                    }
                }
                let errText: String = lastError.map { "\($0)" } ?? "no_track"
                nativeCallDiag("outgoing_cam_publish_on_answer_failed", self.callId, String(errText.prefix(160)))
            }
        }
        let desired = self.session.micEnabled
        guard desired else { return }
        // [2026-10-14 publish-wait] Still in the INITIAL join (.connecting): the
        // post-connect publish in viewDidLoad reads the now-open gate and
        // publishes once — publishing here too would race it (2 mic tracks).
        if r.connectionState == .connecting {
            nativeCallDiag("outgoing_mic_gate_publish_left_to_connect", callId, reason)
            return
        }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                // .reconnecting (resume) → wait for .connected; 101/104 → retry.
                let micPub = try await lkPublishWhenConnected(r, callId: self.callId, label: "gate_mic") {
                    try await CallE2EE.gated(r, self.callId, "gate_mic").setMicrophone(
                        enabled: true,
                        captureOptions: Self.defaultAudioCaptureOptions()
                    )
                }
                if let track = micPub?.track as? LocalAudioTrack {
                    await MainActor.run { self.localAudioTrackRef = track }
                }
                print("[CallVC] outgoing mic published on answer (\(reason)) callId=\(self.callId)")
            } catch {
                // Pre-connect: the post-connect publish reads the open gate.
                print("[CallVC] outgoing mic publish-on-answer failed (benign if pre-connect): \(error)")
            }
        }
    }

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
        // [2026-10-15 cam-1-toque] camEnabled MUST follow hasVideo. The
        // CallSessionState default is `true`, so a VOICE call started with
        // camEnabled=true while the camera was off: the 1st tap on "Vídeo"
        // computed desired = !true = false (a no-op "turn off") and only the
        // 2nd tap turned the camera on (founder: "tem que clicar 2 vezes").
        // Same stale `true` made the screen-share auto-pause/resume turn the
        // camera ON after sharing in a voice call.
        self.session = CallSessionState(
            camEnabled: hasVideo,
            isGroup: false,
            isVideoDefault: hasVideo
        )
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
        // [2026-10-12 deinit-guard] VCs are created on main (present paths).
        if Thread.isMainThread {
            Self.liveInstances.add(self)
        } else {
            DispatchQueue.main.async { [weak self] in
                if let self = self { Self.liveInstances.add(self) }
            }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported for CallViewController")
    }

    // MARK: - Lifecycle

    // [2026-10-11 ongoing-call] On-screen / off-screen transitions drive the
    // in-app "Toque para voltar à ligação" bar (JS) — re-read the snapshot now.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // [2026-10-12 stacked-callvc] A hung-up screen that stayed hidden under
        // another call's screen (forceDismissSelf skip) leaves as soon as it
        // is uncovered.
        if didHangup && hasAppearedOnce {
            DispatchQueue.main.async { [weak self] in self?.forceDismissSelf(reason: "uncovered_after_child_call") }
        }
        hasAppearedOnce = true
        OngoingCallState.shared.notifyChanged()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        OngoingCallState.shared.notifyChanged()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        CallViewController.liveInstance = self // [2026-10-11 ongoing-call]
        view.backgroundColor = UIColor.black // [2026-10-16 P&B premium] era #0B141A
        installCallResilience() // [2026-10-18 call-resilience]
        // [2026-10-09 p2p-ios] Tipo da ligação p/ o P2PCallBridge + estado P2P → UI.
        P2PCallBridge.noteCall(callId: callId, hasVideo: hasVideo)
        installP2PObserver()

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
        installAudioRouteObserver()

        // [DTMF, 2026-05-19] Install the digit-publish bridge.
        installDTMFObserver()

        // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] System call-bar mute.
        installSystemMuteObserver()
        installSystemHoldObserver()

        // [Wave WhatsApp parity, 2026-05-20 gap B5 iOS] AVAudioSession recovery.
        installAVInterruptionObserver()

        // [2026-06-12 outgoing-mic-silence fix] Outgoing-only: re-publish the
        // mic (and retry a swallowed camera first-publish) the moment CallKit
        // activates the audio session — see audioActivatedObserver docs.
        if isOutgoing {
            installAudioActivatedObserver()
        }

        // [2026-05-22 #1349 fix] Caller-side ringback teardown — wire the
        // CallSignalWs receiver-loop notification so this VC stops the
        // ringback engine the moment the callee's WS accept frame lands.
        installRemoteAnsweredObserver()

        // [2026-10-06 native-only outgoing] Remote-end wording + the VC-owned
        // 45s no-answer timeout (see helpers next to openOutgoingMicGate).
        installRemoteEndStatusObserver()
        installPeerStatusObserver() // [2026-10-15 chamadas-dnd]
        if isOutgoing {
            scheduleOutgoingRingTimer()
        }

        // [2026-10-04 RNNoise facade removal] We no longer force a bogus
        // "RNNoise ON" here. RNNoise was never actually linked (see
        // RNNoiseAudioProcessor.swift) — it was a no-op that only pretended to
        // suppress noise. The REAL suppression is WebRTC's built-in NS + Apple
        // VPIO/HW-AEC, enabled unconditionally via defaultAudioCaptureOptions()
        // on the LiveKit RoomOptions, and is untouched. Nothing to force here.
        // [2026-10-11 noise] RNNoise is now REAL (vendored C, see
        // RNNoiseAudioProcessor.swift): attach it to LiveKit's capture APM
        // before any mic publish (fresh Room or adopted preconnect). Respects
        // the `rnnoise_enabled` pref (default ON); no-op/pass-through on failure.
        RNNoiseAudioProcessor.install()

        // [2026-10-16 wave13-B efeitos] Effects auto-paused (heat / battery):
        // discreet notice, only while an effect is actually chosen.
        NotificationCenter.default.addObserver(forName: CallFx.pauseChangedNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.session.camEnabled,
                  CallFx.shared.background != .none || CallFx.shared.light != .none,
                  let text = CallFx.pauseToastText(CallFx.shared.pauseReason) else { return }
            self.showGridToast(text)
        }

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
            // [2026-10-16 P&B premium] roxo → grafite/preto
            UIColor(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0, alpha: 1.0).cgColor,  // grafite
            UIColor(red: 0x0A/255.0, green: 0x0A/255.0, blue: 0x0A/255.0, alpha: 1.0).cgColor,  // quase preto
            UIColor(red: 0x00/255.0, green: 0x00/255.0, blue: 0x00/255.0, alpha: 1.0).cgColor   // preto
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
        // [UI rewrite 2026-05-25] The chevron-down minimizes the call (PiP /
        // floating bar), NOT hangup. Prior wiring fired uikitOnHangupTap which
        // ended the call on a "minimize" gesture — a real bug. Route to the
        // existing handleMinimize() plumbing (untouched).
        minimizeBtn.addTarget(self, action: #selector(uikitOnMinimizeTap), for: .touchUpInside)
        topBar.addSubview(minimizeBtn)

        let barsContainer = UIView()
        barsContainer.translatesAutoresizingMaskIntoConstraints = false
        barsContainer.tag = 9010
        topBar.addSubview(barsContainer)
        for i in 0..<3 {
            let bar = UIView()
            bar.tag = 9011 + i
            bar.backgroundColor = UIColor.white // [2026-10-16 P&B] era verde
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

        // [#1358 video parity 2026-05-25] "More" overflow button (top-right,
        // left of the lock badge). Presents an action sheet wiring the existing
        // native call tools (reactions, screen share, noise suppression,
        // background blur, hold, add member) that the dead SwiftUI CallView
        // used to surface. No new native infra — pure re-wiring of methods that
        // already exist on this VC.
        let moreBtn = UIButton(type: .system)
        moreBtn.translatesAutoresizingMaskIntoConstraints = false
        moreBtn.tintColor = .white
        let moreCfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        moreBtn.setImage(UIImage(systemName: "ellipsis", withConfiguration: moreCfg), for: .normal)
        moreBtn.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        moreBtn.layer.cornerRadius = 18
        moreBtn.clipsToBounds = true
        moreBtn.tag = 9007
        moreBtn.addTarget(self, action: #selector(uikitOnMoreTap), for: .touchUpInside)
        topBar.addSubview(moreBtn)

        // [2026-10-11 ongoing-call] "Mensagem" shortcut (WhatsApp parity):
        // minimizes the call (PiP for video / in-app bar for voice) and opens
        // the chat with this person. 36pt visual, 44pt hit area.
        let msgBtn = CallHitExpandButton(type: .system)
        msgBtn.translatesAutoresizingMaskIntoConstraints = false
        msgBtn.tintColor = .white
        let msgCfg = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        msgBtn.setImage(UIImage(systemName: "message.fill", withConfiguration: msgCfg), for: .normal)
        msgBtn.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        msgBtn.layer.cornerRadius = 18
        msgBtn.clipsToBounds = true
        msgBtn.tag = 9008
        msgBtn.accessibilityLabel = OngoingCallStrings.message
        msgBtn.isHidden = callerEmail.isEmpty && conversationId.isEmpty
        msgBtn.addTarget(self, action: #selector(uikitOnMessageTap), for: .touchUpInside)
        topBar.addSubview(msgBtn)

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
            // [2026-10-16 P&B premium] roxo → cinza
            UIColor(red: 0x48/255.0, green: 0x48/255.0, blue: 0x4A/255.0, alpha: 1.0).cgColor,
            UIColor(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0, alpha: 1.0).cgColor
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
        statusDotsBase = isOutgoing ? "Chamando" : "Conectando"
        statusLabel.text = CallViewController.dotsBase(statusDotsBase)
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
            // [2026-10-06 native-only outgoing] base flips Chamando → Conectando on accept.
            // [2026-10-10 call-states] Chamando → Tocando → Conectando; a
            // transport blip before media shows "Reconectando".
            if self.remoteRefusalActive { return } // [2026-10-11 call-parity]
            // [2026-10-15 chamadas-dnd] "Não perturbe ativo" é estado, não progresso: sem pontinhos.
            if self.peerDndActive && !self.outgoingMicGateOpen && !self.session.isReconnecting {
                lbl.text = CallStrings.s("peerDnd")
                return
            }
            let base = self.session.isReconnecting ? "Reconectando" : self.statusDotsBase
            let dots = String(repeating: ".", count: self.dotCount)
            lbl.text = CallViewController.dotsBase(base) + dots
        }

        // 5. ── Bottom control bar (WhatsApp-grade, ALWAYS visible) ───────────
        //
        // [UI rewrite 2026-05-25] Root cause of "os botões nem aparecem": the
        // prior layout chained the row-1 buttons off each other + off the
        // hangup button with relative constraints, and built a separate
        // floating flip button + four free-floating sub-labels. That fragile
        // web of constraints could land off-screen / collapse, and there was
        // no single safe-area-pinned container guaranteeing visibility.
        //
        // New approach: ONE horizontal UIStackView pinned to the safe-area
        // bottom with hard constraints. Each control is a vertical cell
        // (round glass button + caption) so the whole bar lays out
        // deterministically and is ALWAYS on screen. SF Symbols, translucent
        // glass via UIVisualEffectView, hangup stands out (red, larger). All
        // view tags preserved (9002 mute / 9003 speaker / 9004 hangup /
        // 9005 video / 9006 flip) so every selector + viewWithTag lookup
        // elsewhere in this file keeps resolving.

        // Round glass button. The blur + tint overlay are pinned to the
        // button's edges with Auto Layout (NOT manual frames) so they always
        // fill the circle regardless of when layout runs.
        func glassButton(symbol: String,
                         size: CGFloat,
                         tag: Int,
                         action: Selector,
                         tint: UIColor = UIColor.white.withAlphaComponent(0.16),
                         iconTint: UIColor = .white) -> UIButton {
            let btn = UIButton(type: .system)
            btn.translatesAutoresizingMaskIntoConstraints = false
            btn.layer.cornerRadius = size / 2
            btn.clipsToBounds = true
            btn.tag = tag
            btn.addTarget(self, action: action, for: .touchUpInside)
            btn.widthAnchor.constraint(equalToConstant: size).isActive = true
            btn.heightAnchor.constraint(equalToConstant: size).isActive = true

            let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            blur.translatesAutoresizingMaskIntoConstraints = false
            blur.isUserInteractionEnabled = false
            blur.layer.cornerRadius = size / 2
            blur.clipsToBounds = true
            btn.insertSubview(blur, at: 0)

            let overlay = UIView()
            overlay.translatesAutoresizingMaskIntoConstraints = false
            overlay.backgroundColor = tint
            overlay.isUserInteractionEnabled = false
            overlay.tag = 7   // stable in-button tag so setControlActive finds it
            btn.insertSubview(overlay, aboveSubview: blur)

            NSLayoutConstraint.activate([
                blur.topAnchor.constraint(equalTo: btn.topAnchor),
                blur.bottomAnchor.constraint(equalTo: btn.bottomAnchor),
                blur.leadingAnchor.constraint(equalTo: btn.leadingAnchor),
                blur.trailingAnchor.constraint(equalTo: btn.trailingAnchor),
                overlay.topAnchor.constraint(equalTo: btn.topAnchor),
                overlay.bottomAnchor.constraint(equalTo: btn.bottomAnchor),
                overlay.leadingAnchor.constraint(equalTo: btn.leadingAnchor),
                overlay.trailingAnchor.constraint(equalTo: btn.trailingAnchor),
            ])

            btn.layer.borderWidth = 1
            btn.layer.borderColor = UIColor.white.withAlphaComponent(0.22).cgColor
            btn.tintColor = iconTint
            let cfg = UIImage.SymbolConfiguration(pointSize: size * 0.36, weight: .semibold)
            btn.setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
            // Keep the glyph above the blur + overlay.
            btn.imageView?.layer.zPosition = 2
            return btn
        }

        // A control cell = round button on top + caption beneath, in a tight
        // vertical stack. Returned as the stack so the bar arranges cells
        // evenly. The button keeps its own tag for selector lookups.
        func controlCell(symbol: String,
                         size: CGFloat,
                         tag: Int,
                         caption: String,
                         action: Selector,
                         tint: UIColor = UIColor.white.withAlphaComponent(0.16),
                         iconTint: UIColor = .white) -> (cell: UIStackView, button: UIButton) {
            let btn = glassButton(symbol: symbol, size: size, tag: tag, action: action, tint: tint, iconTint: iconTint)
            let cap = UILabel()
            cap.translatesAutoresizingMaskIntoConstraints = false
            cap.text = caption
            cap.textColor = UIColor.white.withAlphaComponent(0.85)
            cap.font = .systemFont(ofSize: 12, weight: .medium)
            cap.textAlignment = .center
            cap.numberOfLines = 1
            let cell = UIStackView(arrangedSubviews: [btn, cap])
            cell.translatesAutoresizingMaskIntoConstraints = false
            cell.axis = .vertical
            cell.alignment = .center
            cell.spacing = 7
            return (cell, btn)
        }

        // Build cells. Hangup is the visual anchor (red, bigger). Mute /
        // speaker / video are the standard 64pt controls. Flip-camera cell is
        // built but hidden until the camera turns on (applyCamEnabled +
        // localVideoTrack sink toggle its visibility via tag 9006 lookups).
        let hangupColor = UIColor(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0, alpha: 1.0)
        let muteCell    = controlCell(symbol: "mic.fill", size: 64, tag: 9002, caption: "Mudo", action: #selector(uikitOnMuteTap))
        let videoCell   = controlCell(symbol: "video.fill", size: 64, tag: 9005, caption: "Vídeo", action: #selector(uikitOnVideoToggle))
        let flipCell    = controlCell(symbol: "arrow.triangle.2.circlepath.camera.fill", size: 64, tag: 9006, caption: "Girar", action: #selector(uikitOnFlipCamera))
        let speakerCell = controlCell(symbol: "speaker.wave.2.fill", size: 64, tag: 9003, caption: "Alto-falante", action: #selector(uikitOnSpeakerTap))
        // [2026-10-06 screen-share iOS] "Tela" — parity with the JS call screen
        // (which always had a Tela button). Tag 9009. Shares the bar slot with
        // "Girar": the bar fits five 64pt cells + the 72pt hangup, not six, so
        // while the camera is ON (flip visible) this cell hides and screen share
        // stays reachable from the "Mais opções" sheet (row 9072, unchanged).
        let screenCell  = controlCell(symbol: "rectangle.on.rectangle", size: 64, tag: 9009, caption: "Tela", action: #selector(uikitOnScreenShareTap))
        let hangupCell  = controlCell(symbol: "phone.down.fill", size: 72, tag: 9004, caption: "Encerrar", action: #selector(uikitOnHangupTap), tint: hangupColor, iconTint: .white)

        // Flip starts hidden (whole cell) until the camera publishes. The
        // button keeps tag 9006 so applyCamEnabled / the localVideoTrack sink
        // resolve + reveal its cell via updateFlipButtonVisibility.
        flipCell.cell.isHidden = true
        flipCell.cell.alpha = 0

        // Horizontal bar holding every cell, evenly distributed. Pinned to the
        // safe-area bottom by the constraints block below — this is the single
        // source of truth that guarantees the controls are always visible.
        let controlBar = UIStackView(arrangedSubviews: [
            muteCell.cell, videoCell.cell, flipCell.cell, speakerCell.cell, screenCell.cell, hangupCell.cell
        ])
        controlBar.translatesAutoresizingMaskIntoConstraints = false
        controlBar.axis = .horizontal
        controlBar.alignment = .top
        controlBar.distribution = .equalSpacing
        controlBar.spacing = 12
        controlBar.tag = 9008   // bar container — bring-to-front + fade target
        view.addSubview(controlBar)

        // 7. E2E encryption badge
        // [2026-05-25 #1358 video fix] Tag 9045 so applyRemoteVideoTrack can
        // fade this small "Criptografada" pill out when the remote camera takes
        // over the full screen — without a tag it stayed drawn in the center of
        // the screen ON TOP of the remote video (the remote VideoView is
        // inserted aboveSubview: pulse, i.e. BELOW this badge in z-order), so the
        // user saw the word "Criptografada" instead of the peer's video. We keep
        // the badge (encryption is real) — it just belongs with the avatar/name
        // overlay, hidden while video is full-bleed and restored when video off.
        let e2eBadge = UIView()
        e2eBadge.tag = 9045
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

            // [#1358] More overflow button, left of the lock badge.
            moreBtn.trailingAnchor.constraint(equalTo: lockIcon.leadingAnchor, constant: -14),
            moreBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            moreBtn.widthAnchor.constraint(equalToConstant: 36),
            moreBtn.heightAnchor.constraint(equalToConstant: 36),

            // [2026-10-11 ongoing-call] Message shortcut, left of "More".
            msgBtn.trailingAnchor.constraint(equalTo: moreBtn.leadingAnchor, constant: -12),
            msgBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            msgBtn.widthAnchor.constraint(equalToConstant: 36),
            msgBtn.heightAnchor.constraint(equalToConstant: 36),

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

            // ── Bottom control bar — pinned to the safe-area bottom. THIS is
            // the fix: one constraint-driven container guarantees the controls
            // are always laid out on screen, evenly spaced, never off-screen.
            controlBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            controlBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            controlBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])

        // [WAVE 173] Sync session.status → UIKit statusLabel + duration timer.
        statusObserver = session.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] newStatus in
                guard let self = self else { return }

                if newStatus == "Conectado" && self.callConnectedAt == nil {
                    self.callConnectedAt = Date()
                    // [2026-10-14 group-ui] Invites rung before connect → grid now.
                    if !self.gridRinging.isEmpty { self.requestGridRebuild() }
                    // [2026-10-07 ios-native] Live Activity / Dynamic Island
                    // ("Em ligação com Fulano · 03:12"). No-op unless the build
                    // has the ChatyyCallActivity extension (CHATYY_LIVE_ACTIVITY=1).
                    CallLiveActivity.shared.callConnected(
                        callId: self.callId,
                        peerName: self.callerName.isEmpty ? self.callerEmail : self.callerName,
                        isVideo: self.hasVideo,
                        connectedAt: self.callConnectedAt ?? Date()
                    )
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
                        // [2026-10-10 call-states] Mid-call media loss: show
                        // "Reconectando…" instead of a ticking "Conectado";
                        // the count (from first media) resumes on recovery.
                        if self.session.isReconnecting {
                            lbl.text = CallStrings.s("reconnecting")
                            return
                        }
                        // [2026-10-11 call-parity] Hold (ours or the peer's) wins.
                        if self.session.onHold {
                            lbl.text = CallStrings.s("onHold")
                            return
                        }
                        if self.peerOnHold {
                            let who = self.callerName.isEmpty ? self.callerEmail : self.callerName
                            lbl.text = CallStrings.s("peerOnHold", ["name": who])
                            return
                        }
                        let elapsed = Int(Date().timeIntervalSince(connAt))
                        let h = elapsed / 3600
                        let m = (elapsed % 3600) / 60
                        let s = elapsed % 60
                        let c = CallStrings.s("connected")
                        if h > 0 {
                            lbl.text = String(format: "%@ %d:%02d:%02d", c, h, m, s)
                        } else {
                            lbl.text = String(format: "%@ %02d:%02d", c, m, s)
                        }
                    }
                    if let lbl = self.view.viewWithTag(9001) as? UILabel {
                        lbl.text = CallStrings.s("connected") + " 00:00"
                    }
                } else if newStatus != "Conectado" {
                    // [2026-10-06 native-only outgoing] A terminal status must not
                    // be overwritten by the 420ms "Chamando..." dots ticker.
                    if CallViewController.isTerminalStatus(newStatus) {
                        self.dotsTimer?.invalidate()
                        self.dotsTimer = nil
                    }
                    if let lbl = self.view.viewWithTag(9001) as? UILabel {
                        lbl.text = CallViewController.displayStatus(newStatus)
                    }
                }
            }

        // [#1358 video parity 2026-05-25] Build the remote full-bleed VideoView
        // + the draggable local PiP tile + the controls scrim, then wire the
        // Combine sinks that bind session.$remoteVideoTrack / $localVideoTrack
        // into them. This is the heart of the #1358 fix: receiving a video call
        // now actually renders the peer's camera (was an avatar-only screen).
        setupVideoViews()
        // [2026-10-14 self-view] Outgoing VIDEO call: show my own camera in the
        // tile while it rings (the publish stays gated until the answer).
        if hasVideo && isOutgoing { startOutgoingCameraPreview() }

        // [STAGE-A 2026-05-20] GAP #2 — If preconnectRoom (push-receive path)
        // already published a Room for this callId, adopt it instead of
        // building a second one. The singleton's Room is either .connecting
        // or .connected; in either case the RoomDelegate hooks fire through
        // NativeCallRoom forwarders + the listener bag, so we don't even need
        // to bind self as a RoomDelegate (CallView reads `session` which
        // mirrors the NativeCallRoom state). This is what makes audio hot
        // the instant the user taps Accept.
        // [2026-10-18 calls-data] Ring-window Room orphaned by another call's
        // publish → reclaim it (never a 2nd join with the same identity).
        if !isOutgoing {
            NativeCallRoom.shared.reclaimPreconnect(callId: callId, reason: "callvc")
        }
        // [e2ee5 WP-13 2026-10-22] Atender sem ter passado pelo preconnect (toque filtrado, push sem
        // credenciais, cold start): consulta a dica local da conversa/par antes de criar ou adotar o Room.
        if !isOutgoing {
            CallE2EE.shared.noteIncoming(callId: callId, convId: conversationId, peerEmail: callerEmail)
        }
        // [e2ee5 WP-13] Room do toque criado SEM E2EE numa ligação que agora é exigida: sai dele
        // e conecta de novo cifrado (nunca adota mídia em claro). Ligação não cifrada = no-op.
        if let pre = NativeCallRoom.shared.currentRoom(), NativeCallRoom.shared.isPreconnected(callId: callId),
           CallE2EE.shared.roomViolatesPolicy(callId, room: pre) {
            nativeCallDiag("e2ee5_preconnect_plain_drop", callId)
            NativeCallRoom.shared.clear()
            LKLeave.leave(pre, callId: callId, reason: "e2ee5_plain")
        }
        // [e2ee5 WP-13] Cadeado / aviso (escondido se a ligação não é cifrada).
        CallE2EEBadge.attach(to: view, callId: callId, room: { [weak self] in self?.room })
        if NativeCallRoom.shared.isPreconnected(callId: callId) {
            print("[CallVC] STAGE-A: adopting preconnected Room for \(callId)")
            // Take over the Room reference + register as RoomDelegate so
            // participant/track events flow into our SwiftUI session state
            // and the existing extension callbacks fire as if we'd built the
            // Room ourselves.
            if let preRoom = NativeCallRoom.shared.currentRoom() {
                self.room = preRoom
                NativeCallRoom.shared.attachDelegate(self)
                // [iOS black-video fix 2026-05-27] BACKFILL the remote video.
                // preconnectRoom connects to the SFU DURING the ring with
                // delegate=nil, so the peer's already-published camera gets
                // auto-subscribed BEFORE this attachDelegate runs. LiveKit fires
                // didSubscribeTrack only at the moment of subscription and never
                // re-emits — so that track is never bound to remoteVideoView and
                // the remote stays BLACK on incoming-answer (only direction the
                // founder sees black). Walk the already-subscribed remote video
                // publications and bind them via the exact same path as
                // didSubscribeTrack. Idempotent if the delegate later re-fires.
                for rp in preRoom.remoteParticipants.values {
                    for pub in rp.trackPublications.values where pub.kind == .video && pub.isSubscribed {
                        if let vt = pub.track as? VideoTrack {
                            DispatchQueue.main.async { [weak self] in
                                guard let self = self else { return }
                                self.session.remoteVideoTrack = vt
                                self.stopRingbackTone(reason: "adopt_backfill")
                                if #available(iOS 15.0, *) { self.attachPiPRenderer(to: vt) }
                            }
                            break
                        }
                    }
                }
            }
            // Update session.status if already connected.
            // [2026-10-10 call-states] Room connected ≠ media. "Conectado" +
            // timer only if the caller's media is ALREADY subscribed (it may
            // have landed before attachDelegate — didSubscribeTrack never
            // re-fires); otherwise "Conectando…" until didSubscribeTrack, with
            // the 8s/25s watchdog armed.
            let adoptHasMedia = (self.room?.remoteParticipants.values.contains { rp in
                rp.trackPublications.values.contains { $0.isSubscribed && $0.track != nil }
            }) ?? false
            if adoptHasMedia {
                self.markCallConnected(reason: "adopt_backfill_media")
            } else {
                self.statusDotsBase = "Conectando"
                self.scheduleOutgoingConnectFallback(reason: "adopt", seconds: 8)
                self.startPreconnSlowWatch()
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
                // [2026-10-08 call-connect-fast] Join the single-flight publish
                // the CXAnswer/didActivate path already started (usually
                // finished by now) instead of a 2nd setMicrophone. nil = no
                // shared Task for this callId → publish inline as before.
                let sharedMicTask = NativeCallRoom.shared.ensureIncomingMicPublished(
                    callId: callId, reason: "callvc_adopt")
                Task { [weak self] in
                    guard let self = self else { return }
                    do {
                        var micPub: LocalTrackPublication? = nil
                        if let shared = sharedMicTask {
                            micPub = await shared.value
                        }
                        // [2026-10-11 publisher-nil] The shared publish already
                        // waited/rejoined/retried; a direct setMicrophone on a
                        // Room that is not connected only throws "Publisher is
                        // nil". Leave it to the watchdog rejoin in that case.
                        if micPub == nil && !P2PCallBridge.ownsMedia(self.callId) {
                            if r.connectionState == .connected {
                                // [2026-10-14 publish-wait] short retry on 101/104.
                                micPub = try await lkPublishWhenConnected(r, callId: self.callId, label: "stage_a_mic") {
                                    try await CallE2EE.gated(r, self.callId, "stage_a_mic").setMicrophone(
                                        enabled: true,
                                        captureOptions: Self.defaultAudioCaptureOptions()
                                    )
                                }
                            } else {
                                nativeCallDiag("adopt_mic_skip_not_connected", self.callId,
                                               "lk=\(NativeCallRoom.stateName(r.connectionState))")
                            }
                        }
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
                        // [#1358 self-preview fix 2026-05-27] Was `try?` which
                        // SWALLOWED any camera-publish failure → the PiP self-view
                        // never appeared ("só vejo a pessoa, não a gente"). Catch
                        // the error + log to voip_diag, and on success bind the
                        // track via BOTH the Combine sink (session.localVideoTrack)
                        // AND a direct applyLocalVideoTrack() on MainActor as
                        // defense-in-depth in case the sink raced setupVideoViews.
                        // applyLocalVideoTrack is idempotent.
                        do {
                            // [2026-10-14 publish-wait] Was a direct setCamera on
                            // the adopted Room — "Publisher is nil" (101/104)
                            // whenever it was still joining / resuming at Accept.
                            let pub = try await lkPublishWhenConnected(r, callId: self.callId, label: "stage_a_cam") {
                                try await CallE2EE.gated(r, self.callId, "stage_a_cam").setCamera(
                                    enabled: true,
                                    captureOptions: captureOpts,
                                    publishOptions: publishOpts
                                )
                            }
                            if let track = pub?.track as? LocalVideoTrack {
                                await MainActor.run {
                                    self.session.camEnabled = true
                                    self.session.localVideoTrack = track
                                    self.applyLocalVideoTrack(track)
                                }
                                print("[CallVC] STAGE-A: camera published on answer (deferred from preconnect, #1330)")
                                nativeCallDiag("stage_a_cam_published", self.callId)
                            } else {
                                print("[CallVC] STAGE-A: camera publish returned no track")
                                nativeCallDiag("stage_a_cam_no_track", self.callId)
                            }
                        } catch {
                            print("[CallVC] STAGE-A: post-answer CAMERA publish failed: \(error)")
                            nativeCallDiag("stage_a_cam_publish_failed", self.callId, "\(error)")
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
            // [2026-10-18 calls-data] A live ring-window Room of this call that
            // could not be reclaimed must LEAVE before we join again.
            if !isOutgoing && CallResilience.flags().preconnReuse {
                NativeCallRoom.shared.retireOrphanPreconnect(callId: callId, keep: nil, reason: "callvc_fresh")
            }
            startFreshRoomConnect(url: url, token: token)
        } else {
            // [2026-10-15 call-open-fast] Outgoing screen presented BEFORE the
            // LiveKit token exists (tap → screen instantly). The token lands
            // later via supplyLateToken (CXStartCallAction fetch / JS
            // persistPendingLkToken) and the Room connects then.
            print("[CallVC] No lkUrl/lkToken yet — Room.connect waits for supplyLateToken callId=\(callId)")
            if isOutgoing {
                nativeCallDiag("callvc_waiting_token", callId)
                // [2026-10-18 call-connect-fast] resolve the LK host while the token is in flight.
                Self.prewarmLkDns(callId: callId)
            }
        }

        // Stage #993 — set up PiP for video calls. The display layer +
        // controller live for the call's life; sample-buffer enqueue starts
        // once a remote VideoTrack arrives in didSubscribeTrack.
        if hasVideo {
            setupPiPController()
            installBackgroundObserverForPiP()
        }

        // Ringback only fires for the caller side, while we're still waiting.
        // [2026-10-13 ringback] Arm (not play): the tone starts on CallKit's
        // didActivate, or after ~1 s if the session was already active /
        // didActivate never comes — never against a not-yet-activated session.
        if isOutgoing && callConnectedAt == nil && !didHangup {
            armRingbackTone()
            installBackgroundObserverForRingback()
        }
    }

    // [2026-10-15 call-open-fast] Fresh (non-adopted) LiveKit Room connect,
    // extracted from viewDidLoad so an outgoing screen presented without a
    // token can connect as soon as one arrives. Idempotent: one Room per VC.
    private func startFreshRoomConnect(url: String, token: String) {
        guard room == nil, !didHangup else { return }
            Self.rememberLkHost(url) // [2026-10-18 call-connect-fast] next call's DNS prewarm
            print("[CallVC] Starting LiveKit connect — callId=\(callId)")
            // [2026-05-17 MediaPipe] Touch the BackgroundProcessor singleton so
            // it's allocated before Room.connect — the first published video
            // frames already see the blur/wallpaper toggle state from App Group
            // UserDefaults. (RNNoise removed 2026-10-04 — it was a never-linked
            // no-op facade; real audio NS = WebRTC + VPIO via capture options.)
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
            // them on every Room.connect. This (+ Apple VPIO/HW-AEC) is the
            // ONLY noise suppression in effect — there is no RNNoise layer
            // (removed 2026-10-04). RoomOptions init signature (LK Swift 2.5+ verified):
            //   init(defaultCameraCaptureOptions:, defaultScreenShareCaptureOptions:,
            //        defaultAudioCaptureOptions:, defaultVideoPublishOptions:,
            //        defaultAudioPublishOptions:, defaultDataPublishOptions:,
            //        adaptiveStream: Bool = false, dynacast: Bool = false, ...)
            // [WAVE 115, 2026-05-21] Relay-first ICE: start with .relay so the
            // first connect always goes over TURN (never NAT-blocked, 200-500ms).
            // Phase-2 upgrade (P2P attempt after 5s) happens in didConnect delegate.
            var roomOpts = RoomOptions(
                defaultCameraCaptureOptions: Self.defaultCameraCaptureOptions(),
                // [2026-10-06 screen-share iOS] Broadcast-extension capture when
                // ChatyyBroadcastExtension.appex is in the bundle (system-wide
                // ReplayKit picker), in-app capture otherwise. Without this the
                // SDK default (useBroadcastExtension=false) only ever captured
                // THIS app's window — i.e. the call screen itself. See
                // ScreenShareSupport.swift.
                defaultScreenShareCaptureOptions: ScreenShareSupport.captureOptions(),
                defaultAudioCaptureOptions: Self.defaultAudioCaptureOptions(),
                defaultVideoPublishOptions: Self.defaultVideoPublishOptions(),
                // [HD tuning 2026-05-26] Pin DTX + RED on the published Opus
                // stream from the very first packet (loss resilience on cellular).
                defaultAudioPublishOptions: Self.defaultAudioPublishOptions(),
                // [2026-10-11 full-hd] adaptiveStream sizes the subscription to
                // the view (full screen → 1080p layer, PiP → small). With
                // "Economizar dados" it's OFF so we can pin the MEDIUM layer
                // (applyReceivePreference in didSubscribeTrack).
                adaptiveStream: !CallVideoQuality.isDataSaver,
                dynacast: true,
                // [e2ee5 WP-13] nil (= hoje) salvo ligação cifrada (CallE2EE.swift).
                e2eeOptions: CallE2EE.shared.e2eeOptions(callId: self.callId),
                // [video-quality 2026-10-06] Enables Track.statistics (1 Hz
                // getStats) so the "video_quality" diag can report the REAL
                // encoded resolution/bitrate/limitation — stats are nil otherwise.
                reportRemoteTrackStatistics: true
            )
            // [DISABLED 2026-05-25 — call-connect root-cause] Relay-first ICE
            // (iceTransportPolicy=.relay) is now HARMFUL and the biggest cause
            // of slow/flaky connect. The LAN-IP candidate leak it was added to
            // work around is already fixed at the SFU (livekit.yaml
            // rtc.interfaces.includes:[eth0] → only the public IP is
            // advertised, whose UDP 50000-50100 + TCP 7881 are open). Forcing
            // .relay makes the client discard those working direct candidates
            // and depend on LiveKit's advertised embedded TURN (turns:5349),
            // which is BROKEN (external_tls:true with no TLS terminator + cert
            // SAN mismatch) → relay alloc fails → Room can't reach Connected
            // until a retry, producing the multi-second stall. Leaving the
            // policy at default (.all) connects via the direct SFU path
            // immediately; TURN is still gathered as a fallback under .all.
            // The Phase-2 restartIce() in didConnect becomes a harmless no-op.
            NSLog("[CallVC] relay-first DISABLED — using default iceTransportPolicy=all (direct SFU path + TURN fallback)")
            let r = Room(delegate: self, roomOptions: roomOpts)
            self.room = r
            // [#1207 NativeCallRoom REAL, 2026-05-19] Publish to the singleton
            // BEFORE the await so even if JS races us to `adoptNativeRoom()`
            // mid-connect it sees the same Room reference (state will be
            // `.connecting` until didConnect lands). Publishing here also
            // covers paths where Room.connect throws — `clear()` runs in
            // didDisconnect / catch so JS doesn't get a stale snapshot.
            NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId, url: url, token: token)

            // [Wave WhatsApp parity, 2026-05-20 gap C5+F3 iOS] Bind the
            // BackgroundProcessor (MediaPipe blur / wallpaper) to this Room so
            // captured camera frames flow through processPixelBuffer before
            // LK encodes them. No-op when BackgroundProcessor.mode == .off,
            // so binding always is safe (zero cost when user hasn't enabled
            // background effects). Must bind BEFORE setCamera() below so the
            // very first published frame already carries the processor.
            BackgroundProcessorLKAdapter.shared.bind(to: r)
            // [2026-10-04] RNNoiseLKAdapter.bind removed from the path — it was
            // a no-op (RNNoise never linked). Audio noise suppression is handled
            // entirely by WebRTC's NS + Apple VPIO via defaultAudioCaptureOptions.
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    // [CALL-TRACE 2026-05-20 WAVE42] Step 8/12 — viewDidLoad
                    // path connect (non-preconnect — fresh CallVC mount).
                    NSLog("[CallTrace][8/12] LK Room.connect roomName=\(self.callId) serverUrl=\(url) tokenLen=\(token.count) path=viewDidLoad")
                    try await r.connect(url: url, token: token, connectOptions: NativeCallTokenFetcher.connectOptions(
                        forToken: token, oneToOne: !self.session.isGroup)) // [2026-10-19 chamada-queda]
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
                    if self.isOutgoing && !self.outgoingMicGateOpen {
                        // [2026-10-03 ring-leak] Caller: hold the mic until answered.
                        print("[CallVC] outgoing mic publish DEFERRED until answer — callId=\(self.callId)")
                        // [2026-10-18 caller-warm] Warm the publisher PC while it rings
                        // (no media): on answer only the mic track is added.
                        Self.warmPublisherTransport(r, callId: self.callId, label: "outgoing")
                    } else if P2PCallBridge.ownsMedia(self.callId)
                                || (!self.isOutgoing && P2PCallBridge.startIfEligible(callId: self.callId, isCaller: false, hasVideo: self.hasVideo)) {
                        // [2026-10-09 p2p-ios] P2P dono da mídia — LiveKit em espera.
                        print("[CallVC] mic publish skipped — P2P owns media callId=\(self.callId)")
                    } else {
                    // [2026-10-14 publish-wait] connect() returned, but a resume
                    // right after the join throws "Publisher is nil" → wait for
                    // .connected + short retry before giving up ("Erro").
                    let micPub = try await lkPublishWhenConnected(r, callId: self.callId, label: "fresh_mic") {
                        try await CallE2EE.gated(r, self.callId, "fresh_mic").setMicrophone(
                            enabled: true,
                            captureOptions: Self.defaultAudioCaptureOptions()
                        )
                    }
                    // [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] Cache the
                    // local mic track so subsequent applyMicEnabled toggles
                    // take the track.mute() / unmute() fast-path. setMicrophone
                    // returns the publication directly on LK 2.5+.
                    if let track = micPub?.track as? LocalAudioTrack {
                        await MainActor.run { self.localAudioTrackRef = track }
                    }
                    print("[CallVC] Mic published (aec+agc+ns) — callId=\(self.callId)")
                    }
                    if self.hasVideo && self.isOutgoing && !self.outgoingMicGateOpen {
                        // [2026-10-04 ring-leak, VIDEO] Caller: hold the CAMERA
                        // until answered — same gate the mic already uses above.
                        // Without this, the callee's subscribe-only preconnect
                        // received the caller's live camera stream BEFORE tapping
                        // Accept. Published in openOutgoingMicGate() on answer.
                        print("[CallVC] outgoing camera publish DEFERRED until answer — callId=\(self.callId)")
                    } else if self.hasVideo, await MainActor.run(body: { self.outgoingPreviewTrack != nil }) {
                        // [2026-10-14 self-view] Answered while connecting: the
                        // gate path is publishing the ringing preview — a
                        // setCamera here would open a 2nd capturer.
                        print("[CallVC] camera publish left to the answer gate (preview track) — callId=\(self.callId)")
                    } else if self.hasVideo {
                        // [Wave C, 2026-05-18] Pass explicit captureOptions +
                        // publishOptions so the *first* publish carries our
                        // simulcast tiers. Room-level defaults set above already
                        // do this, but some LK Swift revs ignore the RoomOptions
                        // default on the first setCamera() call — pinning per-
                        // call defense-in-depth.
                        let captureOpts = Self.defaultCameraCaptureOptions(position: self.currentCameraPosition)
                        let publishOpts = Self.defaultVideoPublishOptions()
                        if let pub = try? await lkPublishWhenConnected(r, callId: self.callId, label: "fresh_cam", {
                            try await CallE2EE.gated(r, self.callId, "fresh_cam").setCamera(
                                enabled: true,
                                captureOptions: captureOpts,
                                publishOptions: publishOpts
                            )
                        }), let track = pub.track as? LocalVideoTrack {
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
                    // [2026-10-11 publisher-nil] Only if it still is OUR Room.
                    NativeCallRoom.shared.clear(ifCurrent: r, reason: "callvc_connect_failed")
                    // [2026-10-14 leave-first] A half-joined Room must leave too.
                    LKLeave.leave(r, callId: self.callId, reason: "connect_failed")
                    await MainActor.run {
                        self.session.status = "Erro"
                    }
                }
            }
    }

    /// [2026-10-15 call-open-fast] Late LiveKit credentials for an outgoing
    /// screen that was presented before the token existed. First token wins;
    /// ignored once a Room exists, after hangup, or for incoming screens.
    func supplyLateToken(url: String, token: String, source: String) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.supplyLateToken(url: url, token: token, source: source) }
            return
        }
        guard isOutgoing, !didHangup, room == nil, !url.isEmpty, !token.isEmpty else { return }
        if let t = lkToken, !t.isEmpty { return }
        guard isViewLoaded else {
            // viewDidLoad has not run yet — it will connect with these.
            lkUrl = url; lkToken = token
            return
        }
        lkUrl = url; lkToken = token
        nativeCallDiag("callvc_late_token", callId, "src=\(source)")
        startFreshRoomConnect(url: url, token: token)
    }

    /// [2026-10-15 call-open-fast] Route a late token to the live outgoing
    /// screen for `callId` (MAIN THREAD — liveInstances is main-only).
    static func supplyLateTokenIfWaiting(callId: String, url: String, token: String, source: String) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { CallViewController.supplyLateTokenIfWaiting(callId: callId, url: url, token: token, source: source) }
            return
        }
        for vc in liveInstances.allObjects where vc.callId == callId {
            vc.supplyLateToken(url: url, token: token, source: source)
        }
    }

    /// [2026-10-20 callend-reload] 1:1 screens of `callId` still attached to a
    /// window (MAIN THREAD). Used by dismissActiveCallSurfaces to reach a screen
    /// orphaned by a JS reload (presented by the OLD RN root).
    static func liveCallVCs(forCallId callId: String) -> [CallViewController] {
        guard Thread.isMainThread else { return [] }
        return liveInstances.allObjects.filter { $0.callId == callId && $0.viewIfLoaded?.window != nil }
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

    // [minimize-drop fix 2026-05-26] Distinguishes "minimize" (PiP / floating
    // OngoingCallBar) from a real hangup. The incoming-answer path presents
    // this VC as a STANDARD MODAL (CallViewController.present →
    // top.present(vc)), so the presenting VC is the ONLY strong holder of the
    // CallViewController. When handleMinimize() calls `dismiss`, ARC then
    // deallocs the VC and `deinit` ran `room.disconnect()` + NativeCallRoom.
    // clear() — i.e. minimizing HUNG UP the LiveKit Room, and "return to call"
    // had nothing to adopt ("call dropped"). With this flag set, deinit skips
    // the Room teardown so the singleton-owned Room stays connected and the
    // user can re-present + re-adopt it. Real hangup (End button) leaves this
    // false → deinit disconnects as before. Reset on restoreFromMinimize().
    private var isMinimizing: Bool = false
    // [iOS foreground-answer drop fix 2026-05-27] True when JS /call.js has
    // ADOPTED this VC's shared Room and asked us to dismiss for the seamless
    // handoff (dismissIfPresented). Like isMinimizing, this MUST suppress the
    // deinit Room teardown — the Room is owned by NativeCallRoom.shared and JS
    // is now the live UI. Without this, answering with the app OPEN tore down
    // the adopted Room → "atende e a tela desliga" (regression from b58151cb;
    // the db5c53ef deinit guard only covered minimize, not the JS handoff).
    private var cededToJs: Bool = false

    // [2026-10-06 native-only outgoing] `reason` goes out on the WS call_end
    // (hub maps "timeout" while RINGING → call_cancel + push cancel to the
    // callee); `statusText` is what the user sees during the dismiss.
    private func handleHangup(reason: String = "user_hangup", statusText: String = "Encerrada", sendCallEnd: Bool = true) {
        if didHangup {
            // Second tap (or delegate-driven re-entry) — only re-issue the
            // dismiss in case the first one was swallowed by a presentation
            // race. Cheap and idempotent.
            forceDismissSelf(reason: "handleHangup_reentry")
            return
        }
        didHangup = true
        stopCallResilience() // [2026-10-18 call-resilience]
        stopOutgoingCameraPreview() // [2026-10-14 self-view] camera off if never answered
        peerGoneWork?.cancel(); peerGoneWork = nil // [2026-10-12 peer-gone]
        P2PCallBridge.close(callId: callId, reason: "hangup") // [2026-10-09 p2p-ios]
        cancelOutgoingRingTimer()
        cancelOutgoingConnectFallback()
        // [CALL-CLOSE diag 2026-05-27] Mark this teardown path so the next
        // answered call's voip_diag trace shows EXACTLY which path closed it.
        nativeCallDiag("call_close_handleHangup", callId)
        // [2026-10-20 callend-reload] Se o CXEndCallAction abaixo cair num
        // provider velho (JS recarregado no meio da ligação), encerra mesmo assim.
        ExpoCallKitModule.ensureCallKitEnded(callId: callId, src: "handleHangup", delay: 1.5)
        // [minimize-drop fix 2026-05-26] This is a REAL hangup, not a minimize.
        // Clear the minimize flag so the Room teardown below + deinit run, and
        // release the strong holder so the VC can finally dealloc. handleHangup
        // does its own explicit room.disconnect() + NativeCallRoom.clear()
        // (further down), so the call ends regardless of who held the VC.
        isMinimizing = false
        CallViewController.minimizedInstance = nil
        // [2026-10-11 ongoing-call] Remove the in-app "voltar à ligação" bar now.
        OngoingCallState.shared.notifyChanged()
        stopRingbackTone(reason: "handleHangup")
        // [#1171 redux dismiss, 2026-05-19] Update the visible status BEFORE
        // any async teardown. Previously the VC stayed at "Conectando…" while
        // LK disconnect + CXEndCallAction churned for 200-800ms; if the
        // dismiss animation was preempted (e.g. PiP, presenter mid-transition)
        // the user was stranded staring at "Conectando…" with no signal that
        // their hangup had registered. WhatsApp/FaceTime show "Encerrada"
        // for ~250ms before the screen fades — mirror that.
        DispatchQueue.main.async { [weak self] in
            self?.session.status = statusText
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
        // [2026-10-11 call-parity] A remote refusal (declined/busy) already
        // closed the call on the hub; echoing call_end during the hub's 2 s
        // "declined" window looked like a CALLER cancel (history wrong).
        if sendCallEnd {
            CallSignalWs.shared.fireCallEnd(
                callId: callId,
                conversationId: conversationId,
                reason: reason,
                targetEmail: callerEmail
            )
        }
        // [2026-10-11 call-parity] Goodbye frame over LiveKit BEFORE leaving so
        // the peer ends instantly (never waits out its peer-gone grace).
        var goodbye: Data? = nil
        if sendCallEnd && !reason.hasPrefix("remote_") {
            goodbye = try? JSONSerialization.data(withJSONObject: [
                "type": "call_end", "call_id": callId, "reason": reason,
            ])
        }
        NotificationCenter.default.post(
            name: CallViewController.callEndedNotification,
            object: nil,
            userInfo: ["callId": callId]
        )
        // [2026-10-15 screen-share whatsapp-level] Hang-up ends the system
        // broadcast (red pill) immediately + forgets the active room.
        ScreenShareSupport.callEnding(room: self.room, callId: callId)
        if let r = self.room {
            self.room = nil
            // [#1207 NativeCallRoom REAL] Drop the singleton's reference so
            // adoptNativeRoom() returns nil for any subsequent call. Mirrors
            // didDisconnect path; runs in handleHangup because user-initiated
            // hangup teardown happens BEFORE the LK disconnect callback lands.
            // [2026-10-11 publisher-nil] Scoped to OUR Room: a late hangup of a
            // previous call must not wipe the next call's preconnect Room.
            NativeCallRoom.shared.clear(ifCurrent: r, reason: "callvc_hangup")
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
            // [2026-10-14 leave-first] LKLeave: goodbye (≤300 ms) + LEAVE under
            // a background-task assertion (the CallKit end below deactivates
            // audio and the app can be suspended right after — the old
            // detached Task then never sent the leave → SFU ghost ~21 s), real
            // ≤1.5 s budget (task groups wait for a hung child), #757 retry.
            LKLeave.leave(r, callId: callId, reason: reason, goodbye: goodbye)
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
        // [2026-10-12 nuclear-scope] …but NEVER the CXCall of ANOTHER live call
        // (new outgoing/answered call presented while this one shows
        // "Encerrada", redial, glare): ending it killed the fresh call a
        // second after it connected (redial storms 10-11 04:15, 13:15, 22:42
        // and 10-12 15:11 — 3 to 6 attempts to get one working call).
        var protectedUUIDs = Set<UUID>()
        var otherCallIds = Set<String>()
        for other in Self.liveInstances.allObjects where other !== self && !other.didHangup && other.callId != callId {
            otherCallIds.insert(other.callId)
        }
        if let cur = NativeCallRoom.shared.currentCallId(), !cur.isEmpty, cur != callId {
            otherCallIds.insert(cur)
        }
        for cid in otherCallIds {
            if let u = ExpoCallKitModule.sharedCallKitUUID(forCallId: cid) { protectedUUIDs.insert(u) }
        }
        if !protectedUUIDs.isEmpty {
            nativeCallDiag("hangup_nuclear_scoped", callId, "protected=\(protectedUUIDs.count)")
        }
        let observer = CXCallObserver()
        let activeCalls = observer.calls.filter { !$0.hasEnded && !protectedUUIDs.contains($0.uuid) }
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
        // [2026-10-12 stacked-callvc] Another call's live screen is presented
        // ABOVE this one: `self.dismiss` would dismiss THAT child (UIKit
        // dismisses the receiver's presented chain), killing the new call.
        // Stay hidden underneath; this screen leaves with the stack later
        // (a re-tap of Encerrar re-enters here once the child is gone).
        if let child = self.presentedViewController as? CallViewController,
           child.callId != callId, !child.didHangup {
            nativeCallDiag("callvc_dismiss_skip_child_call", callId, "child=\(child.callId) reason=\(reason)")
            return
        }
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
            // [2026-10-12 stacked-callvc] Scoped to THIS call — the global
            // sweep also dismissed a newer call's screen.
            ExpoCallKitModule.dismissActiveCallSurfacesFromVC(reason: "verify_" + reason, forCallId: self.callId)
        }
    }

    private func applyMicEnabled(_ enabled: Bool) {
        // [2026-10-09 p2p-ios] P2P dono da mídia → liga/desliga a track P2P.
        if P2PCallBridge.ownsMedia(callId) {
            P2PCallBridge.setMicEnabled(callId: callId, enabled)
            session.micEnabled = enabled
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitLkLocalAudioChanged"),
                object: nil,
                userInfo: ["enabled": enabled]
            )
            return
        }
        guard let r = self.room else { return }
        // [2026-10-03 ring-leak] Un-muting during the ring must not publish.
        // The desired state is kept in session.micEnabled (set by the caller of
        // this fn / UI); openOutgoingMicGate honours it on answer.
        if isOutgoing && !outgoingMicGateOpen && enabled { return }
        // [2026-05-26 mute→unmute P0 fix] Route BOTH mute and unmute through
        // LocalParticipant.setMicrophone(enabled:) — the exact path the WORKING
        // GroupCallViewController.applyMicEnabled uses.
        //
        // ROOT CAUSE of the "unmute does nothing" bug: the old fast-path cached
        // the LocalAudioTrack and called `track.mute()` / `track.unmute()`
        // directly. On LiveKit Swift 2.x, `LocalAudioTrack.mute()` does NOT just
        // flip a flag — it stops the underlying capturer and detaches the RTC
        // audio sender from the CallKit-owned AVAudioSession. With DTX enabled
        // (defaultAudioPublishOptions) the sender then transmits nothing.
        // `track.unmute()` flips the publication's muted flag back (so the peer
        // sees us "unmuted") but does NOT reliably restart the stopped capturer
        // / re-attach to the now CallKit-owned session — so the mic input stays
        // dead. Result: mute works, unmute is a no-op for actual audio. Always.
        //
        // setMicrophone(enabled: true) deterministically (re)creates + (re)starts
        // the capture and re-attaches it to the active AVAudioSession, which is
        // why the group-call path never had this bug. We pin AudioCaptureOptions
        // on every toggle so AEC + AGC + NS survive a re-publish. We AWAIT the
        // async result and only commit the UI state on success — on failure we
        // roll the SwiftUI mic flag back instead of silently leaving the user
        // muted.
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let micPub = try await CallE2EE.gated(r, self.callId, "mic_toggle", enabling: enabled).setMicrophone(
                    enabled: enabled,
                    captureOptions: Self.defaultAudioCaptureOptions()
                )
                // Refresh the cached track reference each toggle. LK may return
                // the same track on re-enable or a fresh one if it disposed the
                // capturer on mute; either way keep the ref current (used by the
                // post-interruption recovery path, which clears it).
                if let track = micPub?.track as? LocalAudioTrack {
                    await MainActor.run { self.localAudioTrackRef = track }
                } else if !enabled {
                    // Disabled and no publication returned — capturer gone.
                    await MainActor.run { self.localAudioTrackRef = nil }
                }
                // Commit the authoritative UI state on success.
                await MainActor.run { self.session.micEnabled = enabled }
                print("[CallVC] mic \(enabled ? "unmute" : "mute") via setMicrophone ok — callId=\(self.callId)")
            } catch {
                print("[CallVC] applyMicEnabled(\(enabled)) failed: \(error) — reverting UI")
                // Roll back the optimistic UI flip so the button reflects the
                // real (unchanged) mic state instead of lying to the user.
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
    /// Serializes camera on/off (see uikitOnVideoToggle) so overlapping async
    /// toggles can't race and stick. Only ever HELD by a user toggle; always
    /// released when this func's async Task completes or on any early return.
    private var isTogglingCamera = false

    /// [2026-10-10 cam-1-toque] Câmera não ligou de verdade → botão, PiP e
    /// áudio voltam pro estado "desligada" (antes ficava aceso e mentindo).
    @MainActor private func revertCameraUI() {
        session.camEnabled = false
        AudioRouter.shared.setLocalVideoActive(false)
        setControlActive(view.viewWithTag(9005) as? UIButton, active: false, symbol: "video.slash.fill")
        showLocalPip(false)
        updateFlipButtonVisibility(false)
    }

    /// [2026-10-15 cam-1-toque] Voice call, caller still RINGING: the camera
    /// tap is remembered and published on answer (ring-leak gate — nothing
    /// goes out to a callee who hasn't accepted). See openOutgoingMicGate.
    private var camOnAnswerPending = false

    private func applyCamEnabled(_ enabled: Bool) {
        videoAutoPause?.userToggledCamera() // [2026-10-18 call-resilience] the user's choice wins
        if isOutgoing && !outgoingMicGateOpen && !hasVideo {
            camOnAnswerPending = enabled
            Task { @MainActor in self.isTogglingCamera = false }
            return
        }
        // [2026-10-09 p2p-ios] v1 do P2P iOS é só áudio: ligar a câmera devolve
        // a ligação ao LiveKit (já conectado) e segue o caminho normal.
        if enabled && P2PCallBridge.ownsMedia(callId) {
            P2PCallBridge.requestFallback(callId: callId, reason: "video_upgrade")
        }
        // [2026-10-10 cam-1-toque] Founder: "tem que clicar 2 vezes pra ligar a
        // câmera". Causa: no 1º toque a sala ainda podia estar nil (P2P voltando
        // pro LiveKit) ou o setCamera falhava; o catch só desfazia
        // session.camEnabled e o botão ficava ACESO com a câmera desligada → o
        // 2º toque é que ligava. Agora: espera a sala (até ~3s) e tenta de novo
        // (3x); se não der mesmo, devolve botão/PiP/áudio pro estado desligado.
        if self.room == nil && !enabled {
            Task { @MainActor in self.isTogglingCamera = false }
            return
        }
        Task { [weak self] in
            guard let self = self else { return }
            defer { Task { @MainActor in self.isTogglingCamera = false } }
            var waits = 0
            while self.room == nil && waits < 12 {
                waits += 1
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            var attempt = 0
            while true {
            attempt += 1
            guard let r = self.room else {
                await MainActor.run { self.revertCameraUI() }
                return
            }
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
                    let pub = try await CallE2EE.gated(r, self.callId, "cam_toggle").setCamera(
                        enabled: true,
                        captureOptions: captureOpts,
                        publishOptions: publishOpts
                    )
                    await MainActor.run {
                        let track = pub?.track as? LocalVideoTrack
                        self.session.localVideoTrack = track
                        // [autopreview instant 2026-07-15] Bind the local preview
                        // synchronously the moment the track exists — matching the
                        // STAGE-A answer (L978) + didActivate retry (L2255) sites,
                        // which already call applyLocalVideoTrack() directly as
                        // defense-in-depth. This was the ONLY publish site relying
                        // solely on the $localVideoTrack Combine sink, which fires
                        // one extra main-queue hop later; the local VideoView
                        // renders straight from the (already-live) capturer, so a
                        // direct bind shows the self-view as early as this atomic
                        // setCamera() allows. applyLocalVideoTrack is idempotent +
                        // guarded, and touches only the local PiP — no signaling,
                        // no renegotiation.
                        self.applyLocalVideoTrack(track)
                    }
                    print("[CallVC] camera first-publish — callId=\(self.callId)")
                    // [2026-06-01 VIDEO PARITY] Tell the peer we just switched to
                    // video so THEY enable their camera too → both see each other
                    // (WhatsApp audio→video upgrade). JS (/call.js case
                    // 'video_request') + Android (CallActivity.kt:1999) both
                    // already handle this frame.
                    self.sendVideoRequest(action: "request")
                } // else: disable requested but never published — no-op
                break
            } catch {
                print("[CallVC] setCamera(\(enabled)) failed (try \(attempt)): \(error)")
                if enabled && attempt < 3 {
                    try? await Task.sleep(nanoseconds: 600_000_000)
                    continue
                }
                await MainActor.run {
                    if enabled { self.revertCameraUI() } else { self.session.camEnabled = true }
                }
                break
            }
            }
        }
        // [#1358 video parity 2026-05-25] Reflect the toggle into the local PiP
        // tile + the flip-camera button visibility on the main thread.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // PiP visible only when camera on AND a local track exists.
            if enabled, self.session.localVideoTrack != nil {
                self.showLocalPip(true)
            } else if !enabled {
                self.showLocalPip(false)
            }
            self.updateFlipButtonVisibility(enabled)
        }
        // __chatyy_native_call_sync 2026-05-19 — mirror to JS so peer-video
        // gating + recording banner + post-call rating see the toggle.
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitLkLocalVideoChanged"),
            object: nil,
            userInfo: ["enabled": enabled]
        )
    }

    /// [2026-06-01 VIDEO PARITY] Native twin of JS `sendData({type:'video_request',...})`
    /// and Android `requestVideoUpgrade()`. Publishes the audio→video handshake
    /// frame over the LiveKit data channel (reliable) so the peer enables its
    /// camera too. Reuses the same `publish(data:)` API as sendReaction().
    private func sendVideoRequest(action: String) {
        guard let r = self.room else { return }
        let payload = "{\"type\":\"video_request\",\"action\":\"\(action)\"}"
        guard let data = payload.data(using: .utf8) else { return }
        Task {
            do { try await r.localParticipant.publish(data: data) }
            catch { print("[CallVC] sendVideoRequest(\(action)) failed: \(error)") }
        }
    }

    /// [#1358] Show / hide the camera-flip control (tag 9006). Only meaningful
    /// while the local camera is enabled.
    private func updateFlipButtonVisibility(_ camEnabled: Bool) {
        guard let btn = view.viewWithTag(9006) as? UIButton else { return }
        // [UI rewrite 2026-05-25] The flip control lives inside a cell stack
        // (button + "Girar" caption) within the bottom control bar. Toggle the
        // whole CELL so the horizontal stack reflows (no empty gap) when the
        // camera is off. Fall back to the button itself if the cell can't be
        // resolved.
        let cell: UIView = btn.superview ?? btn
        // [2026-10-06 screen-share iOS] "Tela" (tag 9009) and "Girar" (9006)
        // share one slot in the bar — see the controlBar build. Tela shows
        // while the camera is off; the "Mais opções" row covers camera-on.
        let screenCell: UIView? = (view.viewWithTag(9009) as? UIButton).map { $0.superview ?? $0 }
        if camEnabled {
            cell.isHidden = false
            UIView.animate(withDuration: 0.2, animations: {
                cell.alpha = self.controlsHidden ? 0 : 1
                screenCell?.alpha = 0
            }) { _ in
                if let s = screenCell, s.alpha == 0 { s.isHidden = true }
            }
        } else {
            screenCell?.isHidden = false
            UIView.animate(withDuration: 0.2, animations: {
                cell.alpha = 0
                screenCell?.alpha = self.controlsHidden ? 0 : 1
            }) { _ in
                if cell.alpha == 0 { cell.isHidden = true }
            }
        }
    }

    /// [2026-10-07 audio-route] Reflect the router's real route in the
    /// SwiftUI session + the UIKit "Alto-falante" button (tag 9003).
    private func installAudioRouteObserver() {
        guard audioRouteObserver == nil else { return }
        audioRouteObserver = NotificationCenter.default.addObserver(
            forName: AudioRouter.routeDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self,
                  let on = note.userInfo?["speakerOn"] as? Bool else { return }
            if self.session.speakerOn != on { self.session.speakerOn = on }
            let btn = self.view.viewWithTag(9003) as? UIButton
            self.setControlActive(btn, active: on, symbol: on ? "speaker.wave.2.fill" : "speaker.slash.fill")
        }
    }

    /// [Wave B audio, 2026-05-18 / restored 2026-05-19] Speaker toggle now
    /// delegates to AudioRouter so route-change listener stays consistent
    /// with UI state. If a BT/wired headset is connected, the router will
    /// keep it as the route — pressing "speaker" still flips the loudspeaker
    /// on; pressing it again returns to the headset rather than the earpiece
    /// (matches AudioRouter logic).
    /// [2026-10-09 route-picker] Output sheet shown when an external route
    /// exists. The selected route is the sheet's preferredAction (bold).
    /// Button state follows AudioRouter.routeDidChangeNotification.
    private func presentAudioRouteSheet(from sourceButton: UIButton?) {
        let routes = AudioRouter.shared.selectableRoutes()
        guard routes.count > 1 else {
            applySpeaker(!session.speakerOn)
            return
        }
        let sheet = UIAlertController(title: CallNativeStrings.routeSheetTitle(), message: nil, preferredStyle: .actionSheet)
        for route in routes {
            let action = UIAlertAction(title: route.title, style: .default) { [weak self] _ in
                guard let self = self else { return }
                AudioRouter.shared.selectRoute(id: route.id)
                let speakerNow = route.id == "speaker"
                self.session.speakerOn = speakerNow
                NotificationCenter.default.post(
                    name: Notification.Name("ExpoCallKitLkSpeakerChanged"),
                    object: nil,
                    userInfo: ["enabled": speakerNow]
                )
            }
            sheet.addAction(action)
            if route.selected { sheet.preferredAction = action }
        }
        sheet.addAction(UIAlertAction(title: CallNativeStrings.cancel(), style: .cancel, handler: nil))
        if let pop = sheet.popoverPresentationController {
            let anchor: UIView = sourceButton ?? view
            pop.sourceView = anchor
            pop.sourceRect = anchor.bounds
        }
        tapFeedback(sourceButton)
        present(sheet, animated: true)
    }

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
            // [2026-10-14 self-view] Ringing preview (not published yet): the
            // republish fallback below would PUBLISH the camera before the
            // answer (ring-leak gate) — restart the preview capture instead.
            let ringingPreview: LocalVideoTrack? = await MainActor.run { self.outgoingPreviewTrack }
            if let pv = ringingPreview {
                if let cam = pv.capturer as? CameraCapturer {
                    _ = try? await cam.set(cameraPosition: next)
                }
                return
            }
            // Path 2: fallback to the old republish path. Still happens
            // suspend-async so we don't block the UI thread.
            do {
                let opts = Self.defaultCameraCaptureOptions(position: next, profile: CallVideoQuality.current)
                let pub = try await CallE2EE.gated(r, self.callId, "switch_cam").setCamera(
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
                let pub = try? await CallE2EE.gated(r, self.callId, "switch_cam_last").setCamera(enabled: true)
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
        // [2026-05-26 flip-noop fix] ROOT CAUSE of "flip just spins, never
        // changes camera": the previous implementation probed the capturer via
        // Mirror reflection for the selectors `switchCamera` / `toggleCamera`.
        // LiveKit Swift 2.x's `CameraCapturer` exposes NEITHER of those — its
        // real API is `set(cameraPosition:) async throws -> Bool` and
        // `switchCameraPosition() async throws -> Bool`. So `responds(to:)`
        // always returned false here, this returned false every time, and the
        // ONLY thing that ran was the spinner animation in uikitOnFlipCamera()
        // plus a republish fallback that re-published the SAME front camera
        // (currentCameraPosition was already flipped, but the republish path
        // used defaultCameraCaptureOptions(position:) — see note below).
        //
        // Fix: call the real, type-checked LiveKit CameraCapturer API. It's part
        // of the pinned `@livekit/react-native` 2.10.3 → client-sdk-swift 2.x,
        // so the type + async methods are available at compile time. `set`
        // forwards to RTCCameraVideoCapturer.startCapture(with:) on the SAME
        // MediaStreamTrack — no republish, one black frame max, and the actual
        // AVCaptureDevice changes (front↔back). Returns true on success so
        // switchCamera() skips the republish fallback.
        guard let capturer = track.capturer as? CameraCapturer else {
            // Not a CameraCapturer (e.g. screen-share or custom source) — let
            // switchCamera() fall back to the setCamera(captureOptions:) path.
            return false
        }
        do {
            // Prefer the explicit position setter so we converge on the exact
            // target device rather than blindly toggling (avoids drift if some
            // other code already flipped the capturer underneath us).
            let changed = try await capturer.set(cameraPosition: position)
            return changed
        } catch {
            print("[CallVC] trySmoothCameraSwitch set(cameraPosition:) failed: \(error)")
            // Last in-place attempt: plain toggle. If even this throws, return
            // false → republish fallback in switchCamera().
            do {
                _ = try await capturer.switchCameraPosition()
                return true
            } catch {
                print("[CallVC] trySmoothCameraSwitch switchCameraPosition() failed: \(error)")
                return false
            }
        }
    }

    /// Toggle screen share. With the LiveKit broadcast extension wiring in
    /// place (SampleHandler extends LKSampleHandler), `setScreenShareEnabled`
    /// surfaces the system ReplayKit picker AND publishes the resulting
    /// frames into the active Room. The remaining manual step is documented
    /// in BackgroundProcessor.swift / RNNoiseAudioProcessor.swift bottoms —
    /// developer must open the project in Xcode once and verify the build
    /// phase order on the extension target (Sign on Copy: enabled).
    private var screenSharing: Bool = false

    // [more-menu 2026-10-05] Custom dark "Mais opções" overlay (replaces the
    // system action sheet). Both are plain UIKit subviews of `view`; we keep
    // weak refs so dismissMoreMenu() can animate + tear them down. The card is
    // a SIBLING of the backdrop (not a child) so the backdrop's tap-to-dismiss
    // gesture never fires when the user taps a row inside the card.
    private weak var moreMenuBackdrop: UIView?
    private weak var moreMenuCard: UIView?

    // [2026-10-06 screen-share iOS] Top chip "Compartilhando tela · Parar" shown
    // while our screen-share publication is live, and the Darwin observer that
    // hears the broadcast extension stop (user tapped the red status pill).
    private weak var screenShareChip: UIView?
    private var broadcastStopToken: ScreenShareSupport.ObserverToken?
    private var screenShareInFlight: Bool = false

    private func toggleScreenShare() {
        guard let r = self.room else { return }
        guard !screenShareInFlight else { return }
        let currentlySharing = ScreenShareSupport.isSharing(room: r) || screenSharing
        if currentlySharing {
            performScreenShareToggle(room: r, desired: false)
            return
        }
        // [2026-10-15 screen-share whatsapp-level] One-time privacy notice
        // ("Tudo na sua tela, incluindo notificações…"), then straight to the
        // system picker pre-targeted at the Chatyy extension.
        installScreenSharePendingObserver()
        ScreenShareSupport.confirmFirstUse(from: self) { [weak self] in
            guard let self = self, let r = self.room else { return }
            self.performScreenShareToggle(room: r, desired: true)
        }
    }

    /// [2026-10-15] Pending start ended without a publication (picker
    /// dismissed / 60 s timeout / publish failed) → clear the in-flight
    /// guard; alert only on a real failure.
    private var screenSharePendingObserver: NSObjectProtocol?
    private func installScreenSharePendingObserver() {
        guard screenSharePendingObserver == nil else { return }
        screenSharePendingObserver = NotificationCenter.default.addObserver(
            forName: ScreenShareSupport.pendingEndedNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            self.screenShareInFlight = false
            if (note.userInfo?["failed"] as? Bool) == true, self.presentedViewController == nil {
                let alert = UIAlertController(title: CallStrings.s("shareScreen"),
                                              message: CallStrings.s("screenShareFailed"),
                                              preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(alert, animated: true)
            }
        }
    }

    private func performScreenShareToggle(room r: Room, desired: Bool) {
        guard !screenShareInFlight else { return }
        screenShareInFlight = true
        nativeCallDiag(desired ? "screen_share_start_tap" : "screen_share_stop_tap", callId)
        print("[CallVC] screenShare request → \(desired) (broadcastExt=\(ScreenShareSupport.useBroadcastExtension))")
        if desired && ScreenShareSupport.useBroadcastExtension {
            // Listen for the extension's "stopped" Darwin notification so a
            // stop from the system red pill resets our UI even on SDK builds
            // that leave the frame-less track published.
            if broadcastStopToken == nil {
                broadcastStopToken = ScreenShareSupport.observeBroadcastStopped { [weak self] in
                    self?.handleBroadcastStoppedBySystem()
                }
            }
        }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                // Broadcast ext: returns once the system picker is up; the
                // publication is created by the SDK after the user confirms —
                // didPublishTrack (LocalParticipant) flips the UI then.
                // In-app capture: publishes immediately → didPublishTrack too.
                try await ScreenShareSupport.set(room: r, enabled: desired, callId: self.callId)
                await MainActor.run {
                    self.screenShareInFlight = false
                    if !desired {
                        // Stop is synchronous on every SDK build — reflect now.
                        self.applyScreenShareState(false)
                    } else if !ScreenShareSupport.useBroadcastExtension {
                        self.applyScreenShareState(true)
                    }
                    // Broadcast + desired: wait for didPublishTrack.
                }
            } catch {
                print("[CallVC] set(.screenShareVideo, enabled: \(desired)) failed: \(error)")
                nativeCallDiag("screen_share_error", self.callId, String("\(error)".prefix(160)))
                await MainActor.run {
                    self.screenShareInFlight = false
                    self.applyScreenShareState(ScreenShareSupport.isSharing(room: r))
                    if desired {
                        let alert = UIAlertController(
                            title: CallStrings.s("shareScreen"),
                            message: CallStrings.s("screenShareFailed"),
                            preferredStyle: .alert)
                        alert.addAction(UIAlertAction(title: "OK", style: .default))
                        self.present(alert, animated: true)
                    }
                }
            }
        }
    }

    /// Bar button (tag 9009) — same path as the "Mais opções" row.
    @objc private func uikitOnScreenShareTap() {
        tapFeedback(view.viewWithTag(9009) as? UIButton)
        resetControlsAutoHide()
        toggleScreenShare()
    }

    /// Extension process told us (Darwin notification) that the broadcast
    /// ended — the user hit "Parar" on the red status pill or iOS killed it.
    /// Unpublish defensively (older LK 2.x keeps the track) and reset the UI.
    private func handleBroadcastStoppedBySystem() {
        guard screenSharing || (room.map { ScreenShareSupport.isSharing(room: $0) } ?? false) else { return }
        nativeCallDiag("screen_share_stopped_by_system", callId)
        applyScreenShareState(false)
        guard let r = self.room else { return }
        Task {
            do { try await ScreenShareSupport.set(room: r, enabled: false) } catch {
                print("[CallVC] unpublish after system stop failed: \(error)")
            }
        }
    }

    /// Single place that mutates `screenSharing` + the UI (bar button active
    /// state, top chip). Called from the publish/unpublish RoomDelegate hooks,
    /// the toggle, and the Darwin stop observer. Main thread only.
    private func applyScreenShareState(_ sharing: Bool) {
        let was = screenSharing
        screenSharing = sharing
        // [2026-10-15 screen-share whatsapp-level] Camera pauses while the
        // screen is shared (WhatsApp) and comes back when it stops.
        if sharing && !was { pauseCameraForScreenShare() }
        if !sharing && was {
            resumeCameraAfterScreenShare()
            ScreenShareSupport.logExtensionStats(callId: callId)
        }
        if let btn = view.viewWithTag(9009) as? UIButton {
            setControlActive(btn, active: sharing,
                             symbol: sharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
        }
        if sharing { showScreenShareChip() } else { hideScreenShareChip() }
        if !sharing, let tok = broadcastStopToken {
            ScreenShareSupport.stopObserving(tok)
            broadcastStopToken = nil
        }
    }

    // [2026-10-15 screen-share whatsapp-level] Camera auto-pause/resume.
    // Mirrors uikitOnVideoToggle WITHOUT the AudioRouter flip (the route the
    // user had stays put while sharing).
    private var cameraPausedForShare = false

    private func pauseCameraForScreenShare() {
        guard session.camEnabled, !cameraPausedForShare else { return }
        cameraPausedForShare = true
        nativeCallDiag("screen_share_camera_paused", callId)
        setCameraForScreenShare(false, attempt: 0)
    }

    private func resumeCameraAfterScreenShare() {
        guard cameraPausedForShare else { return }
        cameraPausedForShare = false
        // The user may have turned it on by hand meanwhile — nothing to do.
        guard !session.camEnabled, room != nil, !didHangup else { return }
        nativeCallDiag("screen_share_camera_resumed", callId)
        setCameraForScreenShare(true, attempt: 0)
    }

    private func setCameraForScreenShare(_ on: Bool, attempt: Int) {
        if isTogglingCamera {
            // A user toggle is in flight — retry shortly (max ~2 s).
            guard attempt < 8 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.setCameraForScreenShare(on, attempt: attempt + 1)
            }
            return
        }
        guard session.camEnabled != on else { return }
        isTogglingCamera = true
        session.camEnabled = on
        applyCamEnabled(on)
        setControlActive(view.viewWithTag(9005) as? UIButton, active: on,
                         symbol: on ? "video.fill" : "video.slash.fill")
    }

    private func showScreenShareChip() {
        guard screenShareChip == nil else { return }
        let chip = UIView()
        chip.translatesAutoresizingMaskIntoConstraints = false
        chip.backgroundColor = UIColor(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0, alpha: 0.96) // [2026-10-16 P&B] era verde
        chip.layer.cornerRadius = 18
        chip.clipsToBounds = true
        chip.alpha = 0
        chip.tag = 9012   // 9010/9011 belong to the top bar (setControlsHidden resolves it via 9010)

        let icon = UIImageView(image: UIImage(systemName: "rectangle.on.rectangle",
                                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .white
        icon.contentMode = .scaleAspectFit

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = ScreenShareSupport.useBroadcastExtension
            ? CallStrings.s("ssYouAreSharing") : ScreenShareSupport.modeLabel
        label.lineBreakMode = .byTruncatingTail
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.85
        label.textColor = .white
        label.font = .systemFont(ofSize: 13, weight: .semibold)

        let stop = UIButton(type: .system)
        stop.translatesAutoresizingMaskIntoConstraints = false
        stop.setTitle(CallStrings.s("stop"), for: .normal)
        stop.setTitleColor(.white, for: .normal)
        stop.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        stop.backgroundColor = UIColor.white.withAlphaComponent(0.22)
        stop.layer.cornerRadius = 12
        stop.contentEdgeInsets = UIEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
        stop.addTarget(self, action: #selector(uikitOnScreenShareChipStop), for: .touchUpInside)

        chip.addSubview(icon)
        chip.addSubview(label)
        chip.addSubview(stop)
        view.addSubview(chip)
        screenShareChip = chip

        NSLayoutConstraint.activate([
            // Below the top bar (back/minimize + lock/more sit in the first ~44pt).
            chip.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 56),
            chip.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            chip.heightAnchor.constraint(equalToConstant: 36),
            chip.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            chip.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),

            icon.leadingAnchor.constraint(equalTo: chip.leadingAnchor, constant: 12),
            icon.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 16),
            icon.heightAnchor.constraint(equalToConstant: 16),

            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            label.centerYAnchor.constraint(equalTo: chip.centerYAnchor),

            stop.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 10),
            stop.trailingAnchor.constraint(equalTo: chip.trailingAnchor, constant: -6),
            stop.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
        ])
        view.layoutIfNeeded()
        chip.transform = CGAffineTransform(translationX: 0, y: -12)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut]) {
            chip.alpha = 1
            chip.transform = .identity
        }
    }

    private func hideScreenShareChip() {
        guard let chip = screenShareChip else { return }
        screenShareChip = nil
        UIView.animate(withDuration: 0.2, animations: { chip.alpha = 0 }) { _ in
            chip.removeFromSuperview()
        }
    }

    @objc private func uikitOnScreenShareChipStop() {
        toggleScreenShare()
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
            applyMicEnabled(!held && session.micEnabled)
            session.onHold = held
            applyHoldMediaAndSignal(held)
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

    /// [2026-10-11 call-parity] Hold side effects shared by the "Colocar em
    /// espera" row and the system/CallKit hold: pause a live camera (restored
    /// on resume) and tell the PEER over LiveKit data ({type:"hold",on}) so its
    /// screen reads "<nome> colocou a chamada em espera" instead of silence.
    /// Same frame Android CallActivity sends/handles.
    private func applyHoldMediaAndSignal(_ held: Bool) {
        if held {
            if session.camEnabled && !isTogglingCamera {
                preHoldCamEnabled = true
                isTogglingCamera = true
                session.camEnabled = false
                applyCamEnabled(false)
                setControlActive(view.viewWithTag(9005) as? UIButton, active: false, symbol: "video.slash.fill")
            }
        } else if preHoldCamEnabled {
            preHoldCamEnabled = false
            if !session.camEnabled && !isTogglingCamera {
                isTogglingCamera = true
                session.camEnabled = true
                applyCamEnabled(true)
                setControlActive(view.viewWithTag(9005) as? UIButton, active: true, symbol: "video.fill")
            }
        }
        guard let r = self.room,
              let data = try? JSONSerialization.data(withJSONObject: ["type": "hold", "on": held]) else { return }
        Task { try? await r.localParticipant.publish(data: data) }
    }

    /// [2026-10-04] Noise-suppression UI toggle. NOTE: this only reflects the
    /// UI bool + persists the pref — it does NOT toggle real suppression.
    /// RNNoise was never linked (removed as a facade); WebRTC's built-in NS +
    /// Apple VPIO/HW-AEC are always on via defaultAudioCaptureOptions and are
    /// not user-toggleable here. Kept so any surviving toggle closure compiles.
    private func applyNoiseSuppression(_ enabled: Bool) {
        session.noiseSuppression = enabled
        UserDefaults(suiteName: "group.com.onemundo.mail")?.set(enabled, forKey: "rnnoise_enabled")
        // [2026-10-11 noise] The toggle is real again: flips the RNNoise stage
        // live (atomic, next 10 ms frame). WebRTC NS/VPIO stay on regardless.
        RNNoiseAudioProcessor.shared.enabled = enabled
        print("[CallVC] noiseSuppression → \(enabled) (RNNoise available=\(RNNoiseAudioProcessor.shared.available); WebRTC/VPIO always on)")
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

    /// [add-participant 2026-05-26] Add-participant action — presents a native
    /// SwiftUI contact picker (CallParticipantPickerView) that rings the
    /// selected contact INTO this running call's LiveKit room (same call_id)
    /// via the backend `chat_call_add` endpoint. WhatsApp "add to call" parity:
    /// on a 1:1 this converts the call into a group call on the same SFU room.
    /// Replaces the old JS-notification placeholder (the JS /call.js parent
    /// route is dead on mobile post full-native migration).
    private func handleAddMember() {
        // Build the set of identities already in the room (lowercased emails)
        // so the picker hides people who already joined. LiveKit identities may
        // carry a "#deviceHash" suffix — strip it back to the email.
        var presentIds = Set<String>()
        if let r = self.room {
            for p in r.remoteParticipants.values {
                if let raw = p.identity?.stringValue, !raw.isEmpty {
                    let email = raw.split(separator: "#").first.map(String.init) ?? raw
                    presentIds.insert(email.lowercased())
                }
            }
        }

        let picker = CallParticipantPickerView(
            callId: callId,
            conversationId: conversationId,
            isVideo: hasVideo,
            alreadyInCall: presentIds,
            onDismiss: { [weak self] in
                self?.presentedViewController?.dismiss(animated: true)
            },
            // [2026-10-14 group-ui] Rung into the call → "Tocando…" grid tiles.
            onInvited: { [weak self] rung in
                self?.gridAddInvites(rung)
            }
        )
        let host = UIHostingController(rootView: picker)
        // [2026-10-13 add-to-call] Folha escura (a tela de chamada é escura) e alta:
        // a busca abre o teclado, meia altura escondia a lista.
        host.overrideUserInterfaceStyle = .dark
        host.view.backgroundColor = UIColor(white: 0.07, alpha: 1)
        if #available(iOS 15.0, *), let sheet = host.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 22
        }
        present(host, animated: true, completion: nil)
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
        // [minimize-drop fix 2026-05-26] Mark this as a minimize BEFORE any
        // dismiss fires. Both the PiP path (pictureInPictureControllerDidStart
        // → dismiss) and the audio path (dismiss below) deallocate this VC when
        // it was modally presented (incoming-answer flow). Without this flag,
        // the resulting `deinit` disconnects the LiveKit Room and the call
        // drops. The flag keeps the Room (owned by NativeCallRoom.shared) alive
        // so restoreFromMinimize / PiP-restore can re-adopt the live session.
        isMinimizing = true
        // [2026-10-07 audio-route] Chat UI is on screen now — no proximity
        // blanking while the user browses (audio route itself unchanged).
        AudioRouter.shared.setProximitySuspended(true)
        // Park a strong ref so this exact VC (the live Room's RoomDelegate)
        // survives the dismiss and can be re-presented intact on return.
        CallViewController.minimizedInstance = self
        // [2026-10-11 ongoing-call] PiP only when there IS remote video to show
        // (a voice call's PiP window is just a black square). Voice → in-app bar.
        if #available(iOS 15.0, *),
           (hasVideo || pipAttachedTrack != nil),
           let pip = pipController,
           pip.isPictureInPicturePossible,
           !pip.isPictureInPictureActive {
            pip.startPictureInPicture()
            OngoingCallState.shared.notifyChanged()
            return
        }
        // No PiP (audio-only or unsupported device): dismiss self and let the
        // in-app bar take over. [2026-10-11 ongoing-call] The JS bar
        // (components/CallStatusBar.js — live timer, mute, end, pushes content
        // down) is the primary surface; the native overlay below is only the
        // fallback for JS bundles that don't mount it (they never call
        // setInAppCallBarActive). It holds a weak ref to us for tap-to-restore.
        if !OngoingCallBarOverlayController.shared.jsBarActive {
            OngoingCallBarOverlayController.shared.install(
                callerName: callerName,
                hasVideo: hasVideo,
                startedAt: callConnectedAt ?? Date(),
                onTapRestore: { [weak self] in
                    self?.restoreFromMinimize()
                }
            )
        }
        dismiss(animated: true) {
            OngoingCallState.shared.notifyChanged()
        }
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
                "conversationId": conversationId,
                // [2026-10-11 ongoing-call] Peer email so JS can open the 1:1
                // chat even when the call carries no conversation id (incoming).
                "email": callerEmail
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
        // [2026-10-11 ongoing-call] Docked in PiP → stopping PiP runs
        // restoreUserInterfaceForPictureInPictureStop, which re-presents us.
        if #available(iOS 15.0, *), let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
            return
        }
        // [minimize-drop fix 2026-05-26] We're coming back to fullscreen, so a
        // subsequent dismiss (next minimize / hangup) is re-evaluated fresh.
        // (deinit shouldn't run while we're re-presented, but reset defensively
        // so a real hangup after restore still tears the Room down correctly.)
        isMinimizing = false
        AudioRouter.shared.setProximitySuspended(false)
        OngoingCallBarOverlayController.shared.uninstall()
        // Re-present over the current key VC. Walk the chain to find the
        // top-most so we don't get stuck behind a JS modal.
        // NOTE: do NOT clear CallViewController.minimizedInstance before the
        // present() — that static is currently the ONLY strong ref keeping us
        // alive (the original presenter dropped its ref when minimize dismissed
        // us). Clearing it first would dealloc `self` mid-restore. Clear it in
        // the present completion, by which point the presenter holds us again.
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
                top.present(self, animated: true, completion: {
                    // Presenter now holds the strong ref; safe to release the
                    // minimize holder.
                    CallViewController.minimizedInstance = nil
                })
            } else {
                // Already on screen (rare race) — release the holder anyway.
                CallViewController.minimizedInstance = nil
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
    /// [2026-10-11 call-parity] Local floating burst (own or the peer's). Main thread.
    private func showFloatingReaction(_ emoji: String) {
        let reaction = CallFloatingReaction(
            id: UUID(),
            emoji: emoji,
            spawnedAt: Date(),
            xOffset: CGFloat.random(in: -80...80)
        )
        session.floatingReactions.append(reaction)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            self?.session.floatingReactions.removeAll { $0.id == reaction.id }
        }
    }

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
    /// [2026-10-09 system-hold] React to CXSetHeldCallAction coming from the
    /// SYSTEM (call pill, "Hold & Accept" on an incoming GSM call, auto-resume
    /// by CallHoldResumer) — before, only our own "Colocar em espera" updated
    /// the UI, and the module emitted onCallEnded{held} which made JS hang up.
    /// Hold: remember the user's mic choice, mute the published mic, flag
    /// session.onHold. Resume: after CallKit re-activates the audio session,
    /// re-apply the remembered mic (setMicrophone re-creates the capturer on
    /// the live session — same recovery as the interruption path).
    private func installSystemHoldObserver() {
        guard systemHoldObserver == nil else { return }
        systemHoldObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitSystemHoldChanged"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            guard let held = note.userInfo?["held"] as? Bool else { return }
            if let nid = note.userInfo?["callId"] as? String,
               !nid.isEmpty, nid != self.callId,
               ExpoCallKitModule.sharedCallKitUUID(forCallId: self.callId) != nil {
                return
            }
            if held {
                if self.preHoldMicEnabled == nil {
                    self.preHoldMicEnabled = self.session.micEnabled
                }
                self.session.onHold = true
                nativeCallDiag("call_hold", self.callId, "held=1 mic=\(self.preHoldMicEnabled ?? true)")
                self.applyMicEnabled(false)
                self.applyHoldMediaAndSignal(true)
            } else {
                let restore = self.preHoldMicEnabled ?? self.session.micEnabled
                self.preHoldMicEnabled = nil
                self.session.onHold = false
                nativeCallDiag("call_hold", self.callId, "held=0 mic=\(restore)")
                self.applyHoldMediaAndSignal(false)
                // Let CallKit's didActivate land first (audio unit re-armed).
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    guard let self = self, !self.session.onHold else { return }
                    self.session.micEnabled = restore
                    self.applyMicEnabled(restore)
                    AudioRouter.shared.reapplyRoute()
                }
            }
        }
    }

    /// [2026-10-23 callkit-native-buttons] In-app mute → CXSetMutedCallAction
    /// so the NATIVE CallKit screen (lock screen / "Chatyy Audio" screen /
    /// pill) shows the same state. Before, an in-app mute left the native
    /// "Mute" un-highlighted and its first tap was a no-op (asked for the
    /// state we were already in). The action comes back through the provider
    /// delegate → installSystemMuteObserver, which sees the live mic already
    /// matches and only syncs the UI (no loop: deduped by callKitMutedReported).
    fileprivate func syncCallKitMuted(_ muted: Bool) {
        guard callKitMutedReported != muted,
              let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId) else { return }
        callKitMutedReported = muted
        let controller = CXCallController(queue: .main)
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { [weak self] error in
            guard let error = error else { return }
            print("[CallVC] syncCallKitMuted(\(muted)) error: \(error.localizedDescription)")
            self?.callKitMutedReported = nil
        }
    }

    /// [2026-10-23 callkit-native-buttons] "Video" on the NATIVE CallKit
    /// screen of an audio call. iOS does not send a CXAction for it: it
    /// brings the app to the foreground with an INStartCallIntent
    /// (callCapability .videoCall) for the SAME contact. Before, that intent
    /// was routed as "start a new call" (assistant-action deep link / Recents
    /// redial) → dead button or a second call attempt. WhatsApp: the button
    /// opens the call screen and turns the camera on (voice → video upgrade).
    /// Returns false when no 1:1 call screen exists.
    @discardableResult
    static func handleSystemCallIntent(video: Bool) -> Bool {
        guard let vc = ongoingVC() else { return false }
        nativeCallDiag("callkit_video_button", vc.callId, "video=\(video ? 1 : 0) cam=\(vc.session.camEnabled ? 1 : 0) min=\(minimizedInstance === vc ? 1 : 0)")
        let run = { [weak vc] in
            guard let vc = vc, !vc.didHangup else { return }
            if CallViewController.minimizedInstance === vc { vc.restoreFromMinimize() }
            guard video else { return }
            // Let the re-present (and PiP stop) settle before the camera op.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak vc] in
                guard let vc = vc, !vc.didHangup, !vc.session.camEnabled, !vc.session.onHold else { return }
                vc.uikitOnVideoToggle()
            }
        }
        DispatchQueue.main.async {
            if UIApplication.shared.applicationState == .active {
                run()
                return
            }
            // continueUserActivity lands before the scene is foregroundActive
            // (restoreFromMinimize needs it) — run once on didBecomeActive.
            var token: NSObjectProtocol?
            token = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { _ in
                if let t = token { NotificationCenter.default.removeObserver(t) }
                token = nil
                run()
            }
        }
        return true
    }

    private func installSystemMuteObserver() {
        guard systemMuteObserver == nil else { return }
        systemMuteObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitSystemMuteChanged"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            guard let muted = note.userInfo?["muted"] as? Bool else { return }
            // [2026-10-23 callkit-native-buttons] Only drop it when it is
            // provably another call: the earlyProvider path (incoming) used to
            // send the bare UUID string when the callId map missed → the
            // native "Mute" button was silently ignored. maximumCallGroups=1.
            if let nid = note.userInfo?["callId"] as? String,
               !nid.isEmpty, nid != self.callId,
               let mine = ExpoCallKitModule.sharedCallKitUUID(forCallId: self.callId),
               nid != mine.uuidString {
                return
            }
            if self.session.onHold {
                // Held: the mic is already off; remember the choice for resume.
                self.preHoldMicEnabled = !muted
                self.callKitMutedReported = muted
                return
            }
            nativeCallDiag("callkit_mute", self.callId, "muted=\(muted ? 1 : 0)")
            self.callKitMutedReported = muted
            let nextEnabled = !muted
            self.setControlActive(self.view.viewWithTag(9002) as? UIButton, active: muted,
                                  symbol: muted ? "mic.slash.fill" : "mic.fill")
            // [2026-05-26 mute→unmute P0 fix v2] Reconcile against the REAL
            // track state, not the cached @Published bool. The old guard
            // `if self.session.micEnabled == nextEnabled { return }` could
            // short-circuit a legitimate CallKit unmute when session.micEnabled
            // had drifted, leaving the mic dead. Apply BOTH directions through
            // setMicrophone(enabled:) and only skip when the LIVE publication
            // already matches.
            if let r = self.room, r.localParticipant.isMicrophoneEnabled() == nextEnabled {
                // Live state already matches — just keep the UI flag in sync.
                self.session.micEnabled = nextEnabled
                return
            }
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
                // [2026-10-09 p2p-ios] P2P dono da mídia: a pilha P2P retoma
                // sozinha com a sessão reativada; só reaplica o estado do mic.
                if P2PCallBridge.ownsMedia(self.callId) {
                    P2PCallBridge.setMicEnabled(callId: self.callId, desired)
                    return
                }
                Task { [weak self] in
                    guard let self = self, let r = self.room else { return }
                    do {
                        try await CallE2EE.gated(r, self.callId, "interruption_mic", enabling: desired).setMicrophone(
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

    /// [2026-06-12 outgoing-mic-silence fix] Re-publish the mic (and retry a
    /// silently-failed camera first-publish) the moment CallKit activates the
    /// AVAudioSession. Mirrors the post-interruption recovery above: going
    /// back through setMicrophone forces LiveKit to tear down the dead
    /// capturer and re-create it against the now-active CallKit-owned
    /// session. Ordering is race-proof:
    ///   - didActivate BEFORE Room.connect resolves → setMicrophone throws
    ///     (room not connected), harmless; the normal post-connect publish
    ///     then captures from an already-active session (the good ordering).
    ///   - didActivate AFTER the publish → this republish replaces the
    ///     silent track (the bug being fixed).
    /// Installed for OUTGOING calls only (viewDidLoad gate) — incoming
    /// publishes post-answer when the session is already active.
    private func installAudioActivatedObserver() {
        guard audioActivatedObserver == nil else { return }
        audioActivatedObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ExpoCallKitAudioSessionActivated"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, let r = self.room else { return }
            let desired = self.session.micEnabled
            // [2026-10-11 publisher-nil] Room not connected yet → setMicrophone
            // would only throw "Publisher is nil" (the "benign" error below,
            // which polluted voip_diag as a failure). The post-connect publish
            // runs with the session already active — the good ordering.
            if r.connectionState != .connected {
                nativeCallDiag("outgoing_mic_republish_deferred", self.callId, "lk=\(NativeCallRoom.stateName(r.connectionState))")
                return
            }
            print("[CallVC] audio session activated — re-applying mic(\(desired)) — callId=\(self.callId)")
            nativeCallDiag("outgoing_mic_republish_didactivate", self.callId, "desired=\(desired)")
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    if self.outgoingMicGateOpen && !P2PCallBridge.ownsMedia(self.callId) {
                    let micPub = try await CallE2EE.gated(r, self.callId, "didactivate_mic", enabling: desired).setMicrophone(
                        enabled: desired,
                        captureOptions: Self.defaultAudioCaptureOptions()
                    )
                    if let track = micPub?.track as? LocalAudioTrack {
                        await MainActor.run { self.localAudioTrackRef = track }
                    }
                    print("[CallVC] didActivate mic republish(\(desired)) ok — callId=\(self.callId)")
                    } else {
                        print("[CallVC] didActivate mic republish skipped (ring, not answered) — callId=\(self.callId)")
                    }
                } catch {
                    // Pre-connect activation lands here (room not connected
                    // yet) — benign, the post-connect publish takes over.
                    print("[CallVC] didActivate mic republish failed (benign if pre-connect): \(error)")
                    nativeCallDiag("outgoing_mic_republish_failed", self.callId, "\(error)")
                }
                // [#1358 outgoing video] The viewDidLoad camera publish uses
                // `try?` and can fail silently when capture starts before the
                // session/devices are ready. If we still have no local track
                // for a video call, retry once now that the session is live —
                // restores the caller's self-preview AND the callee's view of
                // the caller.
                if self.hasVideo, self.session.localVideoTrack == nil {
                    do {
                        let pub = try await CallE2EE.gated(r, self.callId, "didactivate_cam").setCamera(
                            enabled: true,
                            captureOptions: Self.defaultCameraCaptureOptions(position: self.currentCameraPosition),
                            publishOptions: Self.defaultVideoPublishOptions()
                        )
                        if let track = pub?.track as? LocalVideoTrack {
                            await MainActor.run {
                                self.session.camEnabled = true
                                self.session.localVideoTrack = track
                                self.applyLocalVideoTrack(track)
                            }
                            print("[CallVC] didActivate camera retry-publish ok — callId=\(self.callId)")
                            nativeCallDiag("outgoing_cam_republish_didactivate", self.callId)
                        }
                    } catch {
                        print("[CallVC] didActivate camera retry-publish failed: \(error)")
                        nativeCallDiag("outgoing_cam_republish_failed", self.callId, "\(error)")
                    }
                }
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
    /// [2026-10-09 p2p-ios] P2P conectou → "Conectado" (caller: também avisa o
    /// CallKit via markCallConnected). Queda p/ o LiveKit é tratada no bridge.
    private func installP2PObserver() {
        guard p2pObserver == nil else { return }
        p2pObserver = NotificationCenter.default.addObserver(
            forName: P2PCallBridge.stateChangedNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            guard (note.userInfo?["callId"] as? String) == self.callId else { return }
            let st = (note.userInfo?["state"] as? String) ?? ""
            if st == "connected" {
                self.stopRingbackTone(reason: "p2p_connected")
                if self.isOutgoing {
                    self.markCallConnected(reason: "p2p")
                } else {
                    // [2026-10-10 call-states] same single commit point (also
                    // cancels the connect watchdog); idempotent.
                    self.markCallConnected(reason: "p2p_incoming")
                }
            }
        }
    }

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
            self.openOutgoingMicGate(reason: "ws_call_accepted")
            self.stopRingbackTone(reason: "remote_answered")
            // [2026-10-06 native-only outgoing] WhatsApp-style state text:
            // Chamando → (accept) Conectando → (first remote media) Conectado +
            // timer. "Conectado" is committed by markCallConnected() on the first
            // subscribed remote track; a 5s fallback covers a callee that
            // answered but publishes nothing (mic denied).
            // [2026-10-10 call-states] → connect watchdog: 8s nudge, 25s
            // fail (or commit if the peer is in the room with a muted mic).
            if self.session.status != "Conectado" {
                self.statusDotsBase = "Conectando"
                if !self.session.isReconnecting { self.session.status = "Conectando" }
                self.scheduleOutgoingConnectFallback(reason: "ws_call_accepted", seconds: 8)
            }

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

    // MARK: - Ringback [2026-10-13 ringback rewrite]
    //
    // Founder bug (iOS 5.0.5 ~676/677): "quando estou chamando o amigo NÃO toca
    // o tuu… tuu…". Root cause: the old AVAudioEngine ringback was started in
    // viewDidLoad, ~0.8 s BEFORE CallKit's provider(_:didActivate:) (voip_diag:
    // callvc present 54.8 → lk_audio_bridge_activated 55.6). The engine bound to
    // the pre-activation session format; CallKit's activation + the LiveKit
    // audio-unit bring-up (LKAudioSessionCallKitBridge) reconfigured the session
    // → AVAudioEngineConfigurationChange → the engine STOPS ITSELF and nothing
    // restarted it (ringbackActive stayed true, so even a 2nd start was a no-op).
    // A brief app-inactive blip (CallKit UI) also hard-stopped it for good via
    // willResignActive.
    //
    // Now:
    //  * armRingbackTone() at dial; the tone starts on didActivate (+250 ms so
    //    the LK unit settles) or after 1 s fallback (session already active /
    //    didActivate late) — WhatsApp-like "~1 s after dialing".
    //  * AVAudioPlayer on an in-memory WAV (425 Hz, 1 s on / 4 s off = BR/CEPT).
    //    It follows the CURRENT route (earpiece by default via AudioRouter,
    //    speaker / BT when selected) and survives HW format changes.
    //  * Self-healing: didActivate rebuilds, interruption-ended / didBecomeActive
    //    / mediaServicesReset resume, and a 1 s watchdog re-plays if anything
    //    stopped it while ringbackWanted.
    //  * stopRingbackTone(reason:) clears ringbackWanted first, so every
    //    answer/decline/busy/no-answer/hangup path stops it immediately and no
    //    pending restart can bring it back.

    private static let kRingbackFallbackDelay: Double = 1.0
    private static let kRingbackAfterActivateDelay: Double = 0.25
    private static let kRingbackMaxRebuilds: Int = 30
    private static var cachedRingbackWav: Data?
    private static var cachedBusyWav: Data?

    /// Mono 16-bit PCM WAV. `pattern` = [(onSeconds, offSeconds)] played once;
    /// 15 ms fade in/out on every burst (no clicks).
    fileprivate static func makeToneWav(frequency: Double,
                                        pattern: [(Double, Double)],
                                        amplitude: Double,
                                        sampleRate: Int = 16000) -> Data {
        var samples: [Int16] = []
        let fade = max(1, Int(Double(sampleRate) * 0.015))
        let step = 2.0 * Double.pi * frequency / Double(sampleRate)
        for (onSec, offSec) in pattern {
            let on = Int(Double(sampleRate) * onSec)
            let off = Int(Double(sampleRate) * offSec)
            var phase = 0.0
            for i in 0..<on {
                var env = 1.0
                if i < fade { env = Double(i) / Double(fade) }
                else if i > on - fade { env = Double(on - i) / Double(fade) }
                let v = max(-1.0, min(1.0, sin(phase) * amplitude * env))
                samples.append(Int16(v * 32767.0))
                phase += step
                if phase > 2.0 * Double.pi { phase -= 2.0 * Double.pi }
            }
            if off > 0 { samples.append(contentsOf: repeatElement(Int16(0), count: off)) }
        }
        let dataBytes = samples.count * 2
        var b: [UInt8] = []
        b.reserveCapacity(44 + dataBytes)
        func le32(_ v: UInt32) {
            b.append(UInt8(v & 0xff)); b.append(UInt8((v >> 8) & 0xff))
            b.append(UInt8((v >> 16) & 0xff)); b.append(UInt8((v >> 24) & 0xff))
        }
        func le16(_ v: UInt16) {
            b.append(UInt8(v & 0xff)); b.append(UInt8((v >> 8) & 0xff))
        }
        b.append(contentsOf: Array("RIFF".utf8)); le32(UInt32(36 + dataBytes))
        b.append(contentsOf: Array("WAVE".utf8))
        b.append(contentsOf: Array("fmt ".utf8)); le32(16)
        le16(1)                                 // PCM
        le16(1)                                 // mono
        le32(UInt32(sampleRate))
        le32(UInt32(sampleRate * 2))            // byte rate
        le16(2)                                 // block align
        le16(16)                                // bits/sample
        b.append(contentsOf: Array("data".utf8)); le32(UInt32(dataBytes))
        for s in samples {
            let u = UInt16(bitPattern: s)
            b.append(UInt8(u & 0xff)); b.append(UInt8(u >> 8))
        }
        return Data(b)
    }

    private static func ringbackWav() -> Data {
        if let d = cachedRingbackWav { return d }
        // BR (Anatel) / CEPT ringback: 425 Hz, 1 s on, 4 s off.
        let d = makeToneWav(frequency: 425.0, pattern: [(1.0, 4.0)], amplitude: 0.32)
        cachedRingbackWav = d
        return d
    }

    private static func busyWav() -> Data {
        if let d = cachedBusyWav { return d }
        // BR busy: 425 Hz, 250 ms on / 250 ms off, x3 (~1.5 s = refusal label time).
        let d = makeToneWav(frequency: 425.0, pattern: [(0.25, 0.25), (0.25, 0.25), (0.25, 0.25)], amplitude: 0.32)
        cachedBusyWav = d
        return d
    }

    private static func currentOutputName() -> String {
        return AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
    }

    /// Caller dialed: want the ringback. Does NOT touch the audio session yet.
    private func armRingbackTone() {
        guard isOutgoing, !ringbackWanted, callConnectedAt == nil, !didHangup else { return }
        ringbackWanted = true
        ringbackRebuilds = 0
        ringbackStartedAt = nil
        installRingbackSessionObservers()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.ringbackWanted else { return }
            self.startRingbackTone(reason: "fallback_1s")
        }
        ringbackStartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.kRingbackFallbackDelay, execute: work)
        scheduleRingbackWatchdogTick()
        print("[CallVC] ringback: armed — callId=\(callId)")
    }

    /// Start (or resume) the tone. `rebuild` = drop the current player first
    /// (session (re)activated → bind a fresh player to the live session).
    private func startRingbackTone(reason: String, rebuild: Bool = false) {
        guard ringbackWanted, !didHangup, callConnectedAt == nil, !remoteRefusalActive else { return }
        ringbackStartWork?.cancel()
        ringbackStartWork = nil
        if rebuild, let old = ringbackPlayer {
            old.stop()
            ringbackPlayer = nil
        }
        if let p = ringbackPlayer {
            if p.isPlaying { return }
            // Paused by an interruption / route or category change → resume.
            if p.play() {
                print("[CallVC] ringback: resumed (\(reason))")
                nativeCallDiag("ringback_resume", callId, "reason=\(reason) route=\(Self.currentOutputName())")
                return
            }
            p.stop()
            ringbackPlayer = nil
        }
        guard ringbackRebuilds < Self.kRingbackMaxRebuilds else { return }
        ringbackRebuilds += 1
        do {
            let p = try AVAudioPlayer(data: Self.ringbackWav(), fileTypeHint: AVFileType.wav.rawValue)
            p.numberOfLoops = -1
            p.volume = 1.0
            p.prepareToPlay()
            if p.play() {
                ringbackPlayer = p
                let first = ringbackStartedAt == nil
                if first { ringbackStartedAt = Date() }
                print("[CallVC] ringback: started (\(reason)) route=\(Self.currentOutputName())")
                nativeCallDiag(first ? "ringback_start" : "ringback_rebuild", callId,
                               "reason=\(reason) n=\(ringbackRebuilds) route=\(Self.currentOutputName())")
            } else {
                print("[CallVC] ringback: play() returned false (\(reason))")
                nativeCallDiag("ringback_play_false", callId, "reason=\(reason) n=\(ringbackRebuilds)")
            }
        } catch {
            print("[CallVC] ringback: AVAudioPlayer init failed (\(reason)): \(error)")
            nativeCallDiag("ringback_init_failed", callId, "reason=\(reason) err=\(error.localizedDescription)")
        }
    }

    /// 1 s self-heal loop while the caller waits. Stops by itself when
    /// ringbackWanted goes false (no Timer → no thread-affinity issues).
    private func scheduleRingbackWatchdogTick() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, self.ringbackWanted else { return }
            // Before the first start the arm/fallback path owns it.
            if self.ringbackStartWork == nil,
               self.ringbackPlayer?.isPlaying != true,
               !self.remoteRefusalActive {
                self.startRingbackTone(reason: "watchdog")
            }
            self.scheduleRingbackWatchdogTick()
        }
    }

    private func installRingbackSessionObservers() {
        guard ringbackSessionObservers.isEmpty else { return }
        let nc = NotificationCenter.default
        // CallKit activated the session (posted by both provider delegates).
        ringbackSessionObservers.append(nc.addObserver(
            forName: Notification.Name("ExpoCallKitAudioSessionActivated"),
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.ringbackWanted else { return }
            self.ringbackStartWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.ringbackWanted else { return }
                self.startRingbackTone(reason: "didActivate", rebuild: true)
            }
            self.ringbackStartWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.kRingbackAfterActivateDelay, execute: work)
        })
        ringbackSessionObservers.append(nc.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, self.ringbackWanted else { return }
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if kind == .ended {
                self.startRingbackTone(reason: "interruption_ended")
            }
        })
        ringbackSessionObservers.append(nc.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.ringbackWanted else { return }
            self.startRingbackTone(reason: "media_services_reset", rebuild: true)
        })
        ringbackSessionObservers.append(nc.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.ringbackWanted else { return }
            self.startRingbackTone(reason: "did_become_active")
        })
    }

    private func stopRingbackTone(reason: String) {
        let wasWanted = ringbackWanted
        ringbackWanted = false
        ringbackStartWork?.cancel()
        ringbackStartWork = nil
        for o in ringbackSessionObservers { NotificationCenter.default.removeObserver(o) }
        ringbackSessionObservers.removeAll()
        let hadPlayer = ringbackPlayer != nil
        ringbackPlayer?.stop()
        ringbackPlayer = nil
        guard wasWanted || hadPlayer else { return }
        let playedMs = ringbackStartedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? -1
        print("[CallVC] ringback: stopped (\(reason)) played_ms=\(playedMs)")
        nativeCallDiag("ringback_stop", callId, "reason=\(reason) played_ms=\(playedMs) n=\(ringbackRebuilds)")
    }

    private func installBackgroundObserverForRingback() {
        // [2026-10-13 ringback] Do NOT stop on willResignActive any more: the
        // CallKit outgoing transaction can blip the app to .inactive (voip_diag
        // presentVC_waiting_active state=1) and that killed the tone for good.
        // A CallKit call keeps the session (UIBackgroundModes audio+voip), so
        // the tone continues like WhatsApp; every end path stops it explicitly.
        guard ringbackResignObserver == nil else { return }
        ringbackResignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, self.ringbackWanted else { return }
            print("[CallVC] ringback: willResignActive — keeping tone (CallKit owns the session)")
        }
    }

    // MARK: - Ongoing call (in-app bar) [2026-10-11 ongoing-call]
    //
    // Read/act surface for OngoingCallState (OngoingCallSupport.swift). All of
    // these run on the main thread (OngoingCallState dispatches there).

    private static func ongoingVC() -> CallViewController? {
        if let vc = minimizedInstance, !vc.didHangup { return vc }
        if let vc = liveInstance, !vc.didHangup { return vc }
        return nil
    }

    static func hasOngoing() -> Bool {
        return ongoingVC() != nil
    }

    /// [2026-10-11 call-parity] True when a 1:1 call screen for `callId` exists
    /// (an incoming CallVC is only presented AFTER answer) — used to tell a
    /// pre-answer DECLINE from a hangup of an answered call.
    /// [2026-10-14 leave-first] Rooms of the live / minimized 1:1 screens for
    /// `callId` (MAIN THREAD — liveInstances is main-only).
    static func roomsForLeave(callId: String) -> [Room] {
        var out: [Room] = []
        for vc in liveInstances.allObjects where vc.callId == callId {
            if let r = vc.room { out.append(r) }
        }
        if let vc = minimizedInstance, vc.callId == callId, let r = vc.room { out.append(r) }
        return out
    }

    /// [2026-10-14 leave-first] Every 1:1 Room (app terminating). MAIN THREAD.
    static func allRoomsForLeave() -> [Room] {
        var out: [Room] = liveInstances.allObjects.compactMap { $0.room }
        if let r = minimizedInstance?.room { out.append(r) }
        return out
    }

    static func hasCallScreen(callId: String) -> Bool {
        guard !callId.isEmpty else { return false }
        if let vc = minimizedInstance, vc.callId == callId { return true }
        if let vc = liveInstance, vc.callId == callId { return true }
        return false
    }

    /// [2026-10-11 call-parity] Remote refusal of OUR outgoing call (WS
    /// call_end reason declined/busy/unavailable) before any media: show
    /// "Recusada"/"Ocupado"/"Indisponível" ~1.5 s with a short busy tone, then
    /// close. Returns true when the VC took over the dismissal (the caller
    /// must NOT dismiss immediately). WhatsApp behaviour; Android CallActivity
    /// does the same (handleRemoteEnd).
    static func handleRemoteRefusalIfOutgoing(callId: String, reason: String) -> Bool {
        guard let vc = ongoingVC(), vc.callId == callId else { return false }
        // [2026-10-22 recusada] já mostrando "Recusada": quem chegar depois (WS nativo, módulo)
        // também NÃO fecha agora — o VC fecha sozinho em 1,5 s.
        if vc.remoteRefusalActive { return true }
        guard vc.isOutgoing, vc.callConnectedAt == nil else { return false }
        let r = reason.lowercased()
        let label: String
        if r.contains("busy") { label = CallStrings.s("busy") }
        else if r.contains("declin") || r.contains("reject") { label = CallStrings.s("declined") }
        else if r.contains("unavailable") || r.contains("offline") { label = CallStrings.s("unavailable") }
        else { return false }
        vc.beginRemoteRefusal(label: label, reason: r)
        return true
    }

    private func beginRemoteRefusal(label: String, reason: String) {
        remoteRefusalActive = true
        nativeCallDiag("remote_refusal", callId, "reason=\(reason)")
        cancelOutgoingRingTimer()
        cancelOutgoingConnectFallback()
        stopRingbackTone(reason: "remote_refusal")
        dotsTimer?.invalidate()
        dotsTimer = nil
        session.status = label
        if let lbl = view.viewWithTag(9001) as? UILabel { lbl.text = label }
        playBusyToneShort()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.stopBusyTone()
            self.handleHangup(reason: "remote_" + reason, statusText: label, sendCallEnd: false)
        }
    }

    /// [2026-10-13 ringback] ~1.5 s BR busy "tu-tu-tu" (425 Hz, 250 ms on /
    /// 250 ms off ×3) on an AVAudioPlayer — same robust path as the ringback
    /// (the old AVAudioEngine could be silently stopped by a session reconfig).
    private func playBusyToneShort() {
        stopBusyTone()
        do {
            let p = try AVAudioPlayer(data: Self.busyWav(), fileTypeHint: AVFileType.wav.rawValue)
            p.numberOfLoops = 0
            p.volume = 1.0
            p.prepareToPlay()
            if !p.play() {
                print("[CallVC] busy tone play() returned false")
            }
            busyTonePlayer = p
        } catch {
            print("[CallVC] busy tone init failed: \(error)")
        }
    }

    private func stopBusyTone() {
        busyTonePlayer?.stop()
        busyTonePlayer = nil
    }

    /// Snapshot dict (same keys as CallStateSnapshot + minimized/isGroup/
    /// conversationId/canRestore). nil = no live 1:1 call.
    static func ongoingSnapshot() -> [String: Any]? {
        guard let vc = ongoingVC() else { return nil }
        var inPip = false
        if #available(iOS 15.0, *), let pip = vc.pipController, pip.isPictureInPictureActive { inPip = true }
        let offScreen = vc.isViewLoaded && vc.view.window == nil
        let minimized = inPip || (minimizedInstance === vc) || (vc.hasAppearedOnce && offScreen)
        let connected = vc.callConnectedAt != nil
        let duration: Int = {
            guard let at = vc.callConnectedAt else { return 0 }
            return max(0, Int(Date().timeIntervalSince(at)))
        }()
        let ringState: String = vc.session.isReconnecting ? "connecting"
            : (connected ? (vc.session.onHold ? "held" : "active") : (vc.isOutgoing ? "ringing" : "connecting"))
        return [
            "callId": vc.callId,
            "contactEmail": vc.callerEmail,
            "contactName": vc.callerName,
            "isVideo": vc.hasVideo || vc.pipAttachedTrack != nil,
            "mic": vc.session.micEnabled,
            "speaker": vc.session.speakerOn,
            "durationSec": duration,
            "lkConnected": connected,
            "ringState": ringState,
            "minimized": minimized,
            "inPip": inPip,
            "isGroup": false,
            "conversationId": vc.conversationId,
            "canRestore": true,
        ]
    }

    @discardableResult
    static func ongoingRestore() -> Bool {
        guard let vc = ongoingVC() else { return false }
        vc.restoreFromMinimize()
        return true
    }

    @discardableResult
    static func ongoingSetMuted(_ muted: Bool) -> Bool {
        guard let vc = ongoingVC() else { return false }
        let enabled = !muted
        vc.session.micEnabled = enabled
        vc.applyMicEnabled(enabled)
        vc.syncCallKitMuted(muted)
        vc.setControlActive(vc.view.viewWithTag(9002) as? UIButton, active: !enabled,
                            symbol: enabled ? "mic.fill" : "mic.slash.fill")
        return true
    }

    @discardableResult
    static func ongoingHangup() -> Bool {
        guard let vc = ongoingVC() else { return false }
        vc.handleHangup()
        return true
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

        // [2026-10-07 ios-native] The display layer now lives in a
        // PiPSampleBufferView (PiPSampleBufferView.swift) that keeps it sized
        // to the PiP window and rotated by the remote frame's CVO rotation.
        let pipVC = AVPictureInPictureVideoCallViewController()
        pipVC.preferredContentSize = CGSize(width: 1080, height: 1920) // aspect only; updated per remote frame
        let container = PiPSampleBufferView(frame: pipVC.view.bounds)
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pipVC.view.addSubview(container)
        pipVC.view.autoresizesSubviews = true
        let displayLayer = container.displayLayer

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
        self.pipContainer = container
        let renderer = PiPVideoRenderer(displayLayer: displayLayer)
        // PiP window aspect + layer rotation follow the remote video.
        renderer.onFormatChange = { [weak container, weak pipVC] rotation, size in
            container?.setRotation(rotation)
            if size.width > 0, size.height > 0 {
                pipVC?.preferredContentSize = size
            }
        }
        self.pipRenderer = renderer
        print("[CallVC] PiP controller built — waiting for remote video track")
    }

    /// Attach the PiP renderer to the remote VideoTrack so frames feed the
    /// display layer. Called from `didSubscribeTrack`. Safe to call repeatedly
    /// — we de-dupe via `pipAttachedTrack`.
    @available(iOS 15.0, *)
    private func attachPiPRenderer(to track: VideoTrack) {
        // [2026-10-07 ios-native] Audio call upgraded to video (or the PiP
        // controller wasn't built at start): build it lazily so the remote
        // camera can still float in PiP.
        if pipRenderer == nil {
            setupPiPController()
            if pipResignObserver == nil { installBackgroundObserverForPiP() }
        }
        guard let renderer = pipRenderer else { return }
        if pipAttachedTrack === track { return }
        if let prev = pipAttachedTrack {
            prev.remove(videoRenderer: renderer)
        }
        track.add(videoRenderer: renderer)
        pipAttachedTrack = track
        print("[CallVC] PiP renderer attached to remote track")
    }

    /// [2026-10-14 pip-frozen] Founder print 13/10: call minimized, peer turned
    /// the camera OFF → the PiP window kept the LAST frame (frozen face over
    /// Settings). The display layer never clears itself. Now: no live remote
    /// video (track detached / muted / no frame for 1.6 s — also covers a peer
    /// whose camera stops without a mute event, e.g. app backgrounded) →
    /// avatar + name card (WhatsApp); frames back → video again.
    private func refreshPiPPlaceholder() {
        guard let container = pipContainer else { return }
        let fresh: Bool = {
            guard pipAttachedTrack != nil, !remoteVideoMuted, let r = pipRenderer else { return false }
            return CACurrentMediaTime() - r.lastFrameAt < 1.6
        }()
        let img = (viewIfLoaded?.viewWithTag(9030) as? UIImageView)?.image
        container.setPlaceholder(visible: !fresh, name: callerName, image: img)
    }

    private func startPiPStallWatch() {
        pipStallTimer?.invalidate()
        refreshPiPPlaceholder()
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refreshPiPPlaceholder()
        }
        RunLoop.main.add(t, forMode: .common)
        pipStallTimer = t
    }

    private func stopPiPStallWatch() {
        pipStallTimer?.invalidate()
        pipStallTimer = nil
    }

    private func installBackgroundObserverForPiP() {
        pipResignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // [2026-10-07 ios-native] also for audio→video upgrades (remote
            // video attached even though the call started as audio).
            guard let self = self, (self.hasVideo || self.pipAttachedTrack != nil) else { return }
            if #available(iOS 15.0, *), let pip = self.pipController,
               pip.isPictureInPicturePossible, !pip.isPictureInPictureActive {
                print("[CallVC] willResignActive — startPictureInPicture()")
                pip.startPictureInPicture()
            }
        }
    }

    // MARK: - Video quality: Full HD adaptive (2026-10-11 "nível WhatsApp")
    //
    // SINGLE SOURCE OF TRUTH for every camera publish on iOS: the 1:1
    // CallViewController (publish sites + switchCamera), the NativeCallRoom
    // warm/outgoing path and GroupCallViewController all call the static
    // builders below. Mirror of Android `NativeCallRoom.kt › CallVideoQuality`
    // — change the numbers HERE and THERE together.
    //
    // Capture rungs (16:9, 30 fps) + 3-layer simulcast (H.264 hardware via
    // LK's VideoEncoderFactorySimulcast; dynacast pauses layers nobody watches,
    // so in 1:1 only the layer the peer renders flows):
    //   hd1080  1920x1080  2.5 Mbps | 960x540 800k @30 | 480x270 200k @15  (Wi-Fi)
    //   hd720   1280x720   1.7 Mbps | 640x360 450k @30 | 320x180 150k @15
    //   sd540    960x540   0.9 Mbps | 480x270 300k @30 | 240x135 100k @15
    //   "Economizar dados": capture ≤ hd720, top layer 1.0 Mbps (640x360 350k |
    //   320x180 120k) and the receive side asks the SFU for the MEDIUM layer.
    // Default = Full HD on Wi-Fi when the camera has a 1080p30 format; 720p30
    // on cellular / hotspot ("expensive") / Low Data Mode — [2026-10-14
    // call-quality] same envelope WhatsApp/FaceTime use on a phone screen,
    // 1080p over cellular only bought loss + heat. No manual resolution
    // choice — adaptation is automatic (WhatsApp model):
    //   - bandwidth: WebRTC BWE + simulcast shed top layers by themselves; the
    //     AdaptiveVideoController below also steps the CAPTURE down one rung
    //     after ~10 s of poor/lost local quality, back up after ~20 s good;
    //   - CPU: degradation .maintainFramerate while simulcast is on (motion
    //     stays fluid; bandwidth is handled by layer dropping, not by the
    //     encoder), .balanced on the single-encoding fallback;
    //   - thermal: ProcessInfo.thermalState .serious → 720p, .critical → 540p,
    //     recovering when the device cools down.
    // The 2026-05-26 "H.264 + simulcast = dead track" note was really the
    // missing CAMERA permission fixed in the same commit; LK Swift 2.0.18
    // builds every PeerConnection with LKRTCVideoEncoderFactorySimulcast
    // (Core/RTC.swift), the SDK default path. Safety net: if the t+8s diag
    // finds the camera track up but ZERO encoded frames, simulcast is turned
    // off on this device for 7 days (single 1080p encoding) and logged.
    // Screen share stays single-layer 1080p15 ~3 Mbps maintainResolution
    // (screencast source = content hint "detail"/text).
    enum CallVideoProfile: String {
        case hd1080, hd720, sd540

        var dimensions: Dimensions {
            switch self {
            case .hd1080: return Dimensions(width: Int32(1920), height: Int32(1080))
            case .hd720:  return Dimensions(width: Int32(1280), height: Int32(720))
            case .sd540:  return Dimensions(width: Int32(960), height: Int32(540))
            }
        }
        var maxBitrate: Int {
            switch self {
            // [2026-10-14 call-quality] 3.2 → 2.5 Mbps: 1080p30 H.264 HW is
            // visually saturated at ~2.5M on a phone screen; the extra 0.7M
            // only raised loss/queueing on mid Wi-Fi.
            case .hd1080: return 2_500_000
            case .hd720:  return 1_700_000
            case .sd540:  return 900_000
            }
        }
        var maxFps: Int { 30 }
        /// Rank used by the adaptive controller (higher = more demanding).
        var rank: Int {
            switch self {
            case .hd1080: return 3
            case .hd720:  return 2
            case .sd540:  return 1
            }
        }
        static func ofRank(_ r: Int) -> CallVideoProfile {
            if r >= 3 { return .hd1080 }
            if r == 2 { return .hd720 }
            return .sd540
        }
    }

    /// Lightweight NWPathMonitor snapshot. Started once (first access) and
    /// kept alive for the process — cheap, and it means the profile picker
    /// has a real answer by the time the first call publishes.
    final class CallNetworkSnapshot {
        static let shared = CallNetworkSnapshot()
        private let monitor = NWPathMonitor()
        private let lock = NSLock()
        private var _isCellular = false
        private var _isExpensive = false
        private var _isConstrained = false
        private var _label = "unknown"
        private init() {
            monitor.pathUpdateHandler = { [weak self] path in
                guard let self = self else { return }
                let cellular = path.status == .satisfied && path.usesInterfaceType(.cellular) && !path.usesInterfaceType(.wifi)
                let label: String
                if path.status != .satisfied { label = "offline" }
                else if path.usesInterfaceType(.wifi) { label = "wifi" }
                else if cellular { label = "cellular" }
                else if path.usesInterfaceType(.wiredEthernet) { label = "ethernet" }
                else { label = "online" }
                self.lock.lock()
                self._isCellular = cellular
                self._isExpensive = path.isExpensive
                self._isConstrained = path.isConstrained
                self._label = label
                self.lock.unlock()
            }
            monitor.start(queue: DispatchQueue(label: "com.onemundo.callkit.videoq.netmon"))
        }
        var isCellular: Bool { lock.lock(); defer { lock.unlock() }; return _isCellular }
        var isExpensive: Bool { lock.lock(); defer { lock.unlock() }; return _isExpensive }
        var isConstrained: Bool { lock.lock(); defer { lock.unlock() }; return _isConstrained }
        var label: String { lock.lock(); defer { lock.unlock() }; return _label }
    }

    enum CallVideoQuality {
        /// Legacy "Qualidade HD" key (2026-10-06..10-11) — no longer read.
        static let hdPrefKey = "chatyy_call_hd"
        /// "Usar menos dados em chamadas" (Configurações) == "Economizar dados"
        /// (Mais opções da chamada). Per device, UserDefaults.standard.
        static let dataSaverKey = "chatyy_call_data_saver"
        /// Auto safety net (see header): Date until which simulcast stays off.
        static let simulcastOffUntilKey = "chatyy_call_simulcast_off_until"
        /// Screen share: 1080p @ 15 fps, ~3 Mbps, keep resolution (text must
        /// stay legible; frame rate is secondary for slides/documents).
        static let screenShareDimensions = Dimensions(width: Int32(1920), height: Int32(1080))
        static let screenShareEncoding = VideoEncoding(maxBitrate: 3_000_000, maxFps: 15)
        /// [2026-10-15] Poor-network screen-share layer (720p-class @10 fps).
        static let screenShareLowLayer = VideoParameters(
            dimensions: Dimensions(width: Int32(1280), height: Int32(720)),
            encoding: VideoEncoding(maxBitrate: 900_000, maxFps: 10)
        )
        /// Top-layer envelope when "Economizar dados" is on.
        static let saverMaxBitrate = 1_000_000

        private static let lock = NSLock()
        private static var _current: CallVideoProfile = .hd1080
        private static var _published: CallVideoProfile = .hd1080
        private static var _adaptiveCapRank: Int = 3
        /// Last profile handed to a capture (diag + controller read it).
        static var current: CallVideoProfile {
            get { lock.lock(); defer { lock.unlock() }; return _current }
            set { lock.lock(); _current = newValue; lock.unlock() }
        }
        /// Profile the camera ENCODINGS were last computed for.
        static var publishedProfile: CallVideoProfile {
            get { lock.lock(); defer { lock.unlock() }; return _published }
            set { lock.lock(); _published = newValue; lock.unlock() }
        }
        /// Bandwidth term of the live controller (3 = no cap). A camera
        /// published mid-call (audio→video, rejoin) starts at this rung.
        static var adaptiveCapRank: Int {
            get { lock.lock(); defer { lock.unlock() }; return _adaptiveCapRank }
            set { lock.lock(); _adaptiveCapRank = newValue; lock.unlock() }
        }
        static var isDataSaver: Bool {
            get { UserDefaults.standard.bool(forKey: dataSaverKey) }
            set { UserDefaults.standard.set(newValue, forKey: dataSaverKey) }
        }
        /// Legacy bridge: HD is the default now → "HD preferred" == saver OFF.
        static var isHdPreferred: Bool {
            get { !isDataSaver }
            set { isDataSaver = !newValue }
        }
        static var simulcastEnabled: Bool {
            let until = UserDefaults.standard.double(forKey: simulcastOffUntilKey)
            return until <= Date().timeIntervalSince1970
        }
        static func disableSimulcastTemporarily(days: Double = 7) {
            UserDefaults.standard.set(Date().timeIntervalSince1970 + days * 86_400, forKey: simulcastOffUntilKey)
        }

        /// Any built-in camera (front or back) with a ≥1920x1080 format that
        /// runs at 30 fps. LK crops/scales DOWN to the requested size, never up,
        /// so a lens without it just publishes its best ≤1080 format. Cached.
        private static var _cam1080: Bool?
        static var cameraSupports1080: Bool {
            lock.lock()
            if let v = _cam1080 { lock.unlock(); return v }
            lock.unlock()
            var ok = false
            let ds = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera],
                                                      mediaType: .video,
                                                      position: .unspecified)
            outer: for d in ds.devices {
                for f in d.formats {
                    let dims = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                    guard dims.width >= 1920 && dims.height >= 1080 else { continue }
                    if f.videoSupportedFrameRateRanges.contains(where: { $0.maxFrameRate >= 30 }) {
                        ok = true
                        break outer
                    }
                }
            }
            lock.lock(); _cam1080 = ok; lock.unlock()
            return ok
        }

        static var thermalLabel: String {
            switch ProcessInfo.processInfo.thermalState {
            case .nominal: return "nominal"
            case .fair: return "fair"
            case .serious: return "serious"
            case .critical: return "critical"
            @unknown default: return "unknown"
            }
        }

        /// Ceiling right now (no bandwidth term): device, data saver, Low Data
        /// Mode, thermal. Returns profile + reason (diag).
        static func ceiling() -> (CallVideoProfile, String) {
            var p: CallVideoProfile = cameraSupports1080 ? .hd1080 : .hd720
            var why = cameraSupports1080 ? "device_1080" : "camera_no_1080"
            if isDataSaver && p.rank > CallVideoProfile.hd720.rank { p = .hd720; why = "data_saver" }
            if CallNetworkSnapshot.shared.isConstrained && p.rank > CallVideoProfile.hd720.rank { p = .hd720; why = "low_data_mode" }
            // [2026-10-14 call-quality] Full HD only on Wi-Fi/ethernet. The
            // controller re-reads this every 5 s, so Wi-Fi → 4G drops to 720p
            // in place (capture restart, no republish) and climbs back on Wi-Fi.
            let net = CallNetworkSnapshot.shared
            if (net.isCellular || net.isExpensive) && p.rank > CallVideoProfile.hd720.rank { p = .hd720; why = "cellular" }
            switch ProcessInfo.processInfo.thermalState {
            case .critical:
                if p.rank > CallVideoProfile.sd540.rank { p = .sd540; why = "thermal_critical" }
            case .serious:
                if p.rank > CallVideoProfile.hd720.rank { p = .hd720; why = "thermal_serious" }
            default: break
            }
            return (p, why)
        }

        /// Profile for a NEW capture. `localQualityScore` is the 0-3 bars score
        /// (3 = excellent … 0 = lost; pass 3 when unknown). Groups use the same
        /// ladder — tiles pull 270p/540p via adaptiveStream, dynacast pauses
        /// the 1080p layer until someone spotlights the tile.
        static func profile(isGroup: Bool, localQualityScore: Int = 3) -> CallVideoProfile {
            var p = ceiling().0
            if localQualityScore <= 1 && p.rank > CallVideoProfile.hd720.rank { p = .hd720 }
            p = CallVideoProfile.ofRank(min(p.rank, adaptiveCapRank))
            return p
        }

        /// The two extra simulcast layers (smallest first) for top rung `p`.
        static func simulcastLayers(_ p: CallVideoProfile, saver: Bool) -> [VideoParameters] {
            func vp(_ w: Int32, _ h: Int32, _ fps: Int, _ bps: Int) -> VideoParameters {
                VideoParameters(dimensions: Dimensions(width: w, height: h),
                                encoding: VideoEncoding(maxBitrate: bps, maxFps: fps))
            }
            switch p {
            case .hd1080: return [vp(480, 270, 15, 200_000), vp(960, 540, 30, 800_000)]
            case .hd720:  return saver ? [vp(320, 180, 15, 120_000), vp(640, 360, 30, 350_000)]
                                       : [vp(320, 180, 15, 150_000), vp(640, 360, 30, 450_000)]
            case .sd540:  return [vp(240, 135, 15, 100_000), vp(480, 270, 30, 300_000)]
            }
        }

        static func topBitrate(_ p: CallVideoProfile, saver: Bool) -> Int {
            return (saver && p.rank >= CallVideoProfile.hd720.rank) ? min(p.maxBitrate, saverMaxBitrate) : p.maxBitrate
        }

        /// "1920x1080@3200k|480x270@200k|960x540@800k" (+ "|single").
        static func layersLabel(_ p: CallVideoProfile? = nil) -> String {
            let pp = p ?? publishedProfile
            let saver = isDataSaver
            var s = "\(pp.dimensions.width)x\(pp.dimensions.height)@\(topBitrate(pp, saver: saver) / 1000)k"
            if simulcastEnabled {
                for l in simulcastLayers(pp, saver: saver) {
                    s += "|\(l.dimensions.width)x\(l.dimensions.height)@\(l.encoding.maxBitrate / 1000)k"
                }
            } else {
                s += "|single"
            }
            return s
        }
    }

    /// CameraCaptureOptions for the given (or adaptive-picked) profile.
    /// `position` lets switchCamera() rebuild the same options against the
    /// flipped device. LK picks the smallest camera format ≥ dimensions @ fps
    /// (CameraCapturer.startCapture) and crops/scales to exactly 16:9; the
    /// capturer rotates frames itself, so portrait stays 1080x1920 upright.
    /// [2026-05-19 forward-fix] Dimensions(width: Int32, height: Int32) — Swift
    /// does NOT auto-promote Int literals to Int32 (Archive compile, LK 2.0.x).
    static func defaultCameraCaptureOptions(position: AVCaptureDevice.Position = .front,
                                            profile: CallVideoProfile? = nil,
                                            isGroup: Bool = false) -> CameraCaptureOptions {
        let p = profile ?? CallVideoQuality.profile(isGroup: isGroup)
        CallVideoQuality.current = p
        return CameraCaptureOptions(
            position: position,
            dimensions: p.dimensions,
            fps: p.maxFps
        )
    }

    /// VideoPublishOptions for the given (or current) profile.
    ///
    /// `preferredCodec: .h264` — hardware encode/decode on every iPhone and
    /// Android (VP9 lacked reliable HW decode). Mirror on Android
    /// (CallVideoQuality.publishDefaults). [2026-10-11 full-hd] simulcast ON
    /// with the explicit 3-layer ladder (see header); `degradationPreference`
    /// .maintainFramerate (camera, simulcast) / .balanced (single encoding);
    /// screen share keeps its own options below.
    /// LK Swift 2.0.18 init: (name:encoding:screenShareEncoding:simulcast:
    /// simulcastLayers:screenShareSimulcastLayers:preferredCodec:
    /// preferredBackupCodec:degradationPreference:streamName:).
    static func defaultVideoPublishOptions(profile: CallVideoProfile? = nil) -> VideoPublishOptions {
        let p = profile ?? CallVideoQuality.current
        let saver = CallVideoQuality.isDataSaver
        let simulcast = CallVideoQuality.simulcastEnabled
        CallVideoQuality.publishedProfile = p
        return VideoPublishOptions(
            name: nil,
            encoding: VideoEncoding(maxBitrate: CallVideoQuality.topBitrate(p, saver: saver), maxFps: p.maxFps),
            screenShareEncoding: CallVideoQuality.screenShareEncoding,
            simulcast: simulcast,
            simulcastLayers: simulcast ? CallVideoQuality.simulcastLayers(p, saver: saver) : [],
            preferredCodec: .h264,
            // [Wave 19 fix] LK iOS 2.0.x has no backupCodec param; the SFU falls
            // back to the negotiated codec list automatically.
            // [2026-10-14 call-quality] Camera keeps FRAME RATE (FaceTime /
            // Chrome camera default): with simulcast the bandwidth response is
            // dropping layers, so this only decides what CPU/thermal overuse
            // sheds — resolution, not motion. Single encoding (simulcast
            // auto-disabled) stays .balanced: there the QP scaler would
            // otherwise push a congested face to 180p@30.
            degradationPreference: simulcast ? .maintainFramerate : .balanced
        )
    }

    /// Publish options for a SCREEN SHARE track (ScreenShareSupport passes
    /// these explicitly): same codec pin, 1080p15 ~3 Mbps, keep resolution.
    static func screenSharePublishOptions() -> VideoPublishOptions {
        // [2026-10-14 screen-share bg-freeze] Was `.h264`. Founder: "só deixa
        // ver a tela do chat; quando sai do app, trava". The broadcast
        // extension keeps sending frames system-wide, but the ENCODER runs in
        // the host app and iOS invalidates VideoToolbox (HW H.264) sessions
        // while the app is not active (kVTInvalidSessionErr → libwebrtc logs
        // "Invalid compression session, resetting." and emits nothing) — the
        // peer froze on the last frame captured while Chatyy was in front
        // (= the chat). VP8 is libvpx SOFTWARE → keeps encoding in background
        // (the app stays alive via the CallKit/audio background mode). Same
        // choice Jitsi/LiveKit samples make for ReplayKit broadcast. Every
        // receiver (LK Swift/Android/JS) decodes VP8.
        //
        // [2026-10-15 screen-share whatsapp-level] Adaptive: top layer
        // 1080p-class @15 fps ~3 Mbps + a 720p-class @10 fps ~0.9 Mbps
        // simulcast layer. Bad uplink → libwebrtc drops the top layer and the
        // SFU keeps forwarding 720p; a viewer on a bad downlink gets 720p
        // while the others stay at 1080p. `maintainResolution` = under
        // CPU/bandwidth pressure shed FPS, never sharpness (text legible).
        // Simulcast off (auto safety net) → single 1080p layer as before;
        // "Economizar dados" → 1.5 Mbps / 10 fps top.
        // LK Swift 2.0.18: computeVideoEncodings(isScreenShare:) uses
        // `screenShareEncoding` + `screenShareSimulcastLayers`; with one
        // preset it emits [low, base] (q + h rids).
        //
        // [2026-10-15 screen-share sharpness] SIMULCAST OFF for screen share.
        // Founder: "compartilhando a tela, mesmo com internet boa, a qualidade
        // fica muito ruim". SFU log call_1792087759356_yufd6wjh4: only rid "q"
        // (589x1280 ≤900 kbps) EVER reached the SFU in 14 s — the 884x1920
        // "h" layer was never sent; the Android viewer logged rx=590x1280.
        // A (mostly static) screen keeps the sender application-limited, so
        // the BWE never ramps past the low layer and libwebrtc never turns the
        // top layer on. QA harness (qa_ssq_*, 30 s, same layers): simulcast →
        // h=0x0 "bandwidth" the whole time, BWE 220-420 kbps, viewer 720p-
        // class; single → full resolution from t=4 s, BWE 1.1-1.4 Mbps,
        // limitation none. Single layer + maintainResolution = full sharpness
        // always; under real congestion VP8 raises QP / drops fps instead.
        // (`screenShareLowLayer` kept for reference / quick revert.)
        let top = CallVideoQuality.isDataSaver
            ? VideoEncoding(maxBitrate: 1_500_000, maxFps: 10)
            : CallVideoQuality.screenShareEncoding
        return VideoPublishOptions(
            name: nil,
            encoding: top,
            screenShareEncoding: top,
            simulcast: false,
            simulcastLayers: [],
            screenShareSimulcastLayers: [],
            preferredCodec: .vp8,
            degradationPreference: .maintainResolution
        )
    }

    /// [2026-10-11 full-hd] Per-call capture controller shared by the 1:1 VC
    /// and GroupCallViewController (main thread only). Every 5 s: ceiling
    /// (device / data saver / Low Data Mode / thermal) ∧ bandwidth term
    /// (poor/lost ≥ 2 ticks → one rung down; good ≥ 4 ticks → one rung up,
    /// 20 s cool-down between upward moves) → retarget the LIVE capturer in
    /// place (CameraCapturer.set(options:) = capture restart, same track, no
    /// republish). Thermal changes re-evaluate immediately.
    final class AdaptiveVideoController {
        private weak var room: Room?
        private let callId: String
        private let canApply: () -> Bool
        private var timer: Timer?
        private var thermalObserver: NSObjectProtocol?
        private(set) var lastScore = -1
        private var poorTicks = 0
        private var goodTicks = 0
        private var bwLevel = 3
        private var lastChangeAt = Date()
        private var lastThermal = ""
        private var applying = false

        init(room: Room, callId: String, canApply: @escaping () -> Bool = { true }) {
            self.room = room
            self.callId = callId
            self.canApply = canApply
        }

        func start() {
            stop()
            CallVideoQuality.adaptiveCapRank = 3
            // Start from the rung the call actually opened at: climbing above
            // a cautious start (Low Data Mode / poor bars) needs ~20 s of good.
            bwLevel = CallVideoQuality.current.rank
            lastChangeAt = Date()
            lastThermal = CallVideoQuality.thermalLabel
            let t = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in self?.evaluate("tick") }
            RunLoop.main.add(t, forMode: .common)
            timer = t
            thermalObserver = NotificationCenter.default.addObserver(
                forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.evaluate("thermal") }
        }

        func stop() {
            timer?.invalidate()
            timer = nil
            if let o = thermalObserver { NotificationCenter.default.removeObserver(o) }
            thermalObserver = nil
        }

        deinit { stop() }

        /// Local ConnectionQuality (0 lost, 1 poor, 2 good, 3 excellent).
        func noteLocalQuality(_ score: Int) { lastScore = score }

        /// "Economizar dados" flipped: allow an immediate move either way.
        func dataSaverChanged() {
            lastChangeAt = .distantPast
            if !CallVideoQuality.isDataSaver { bwLevel = CallVideoProfile.hd1080.rank }
            evaluate("data_saver")
        }

        private func evaluate(_ reason: String) {
            let now = Date()
            let since = now.timeIntervalSince(lastChangeAt)
            let score = lastScore
            if score >= 0 && score <= 1 { poorTicks += 1; goodTicks = 0 } else if score >= 2 { goodTicks += 1; poorTicks = 0 }
            let cur = CallVideoQuality.current
            if poorTicks >= 2 && since >= 8 && bwLevel > CallVideoProfile.sd540.rank {
                bwLevel = max(CallVideoProfile.sd540.rank, min(bwLevel, cur.rank) - 1)
                poorTicks = 0
            } else if goodTicks >= 4 && since >= 20 && bwLevel < CallVideoProfile.hd1080.rank {
                bwLevel = min(CallVideoProfile.hd1080.rank, bwLevel + 1)
                goodTicks = 0
            }
            CallVideoQuality.adaptiveCapRank = bwLevel
            let (ceil, why) = CallVideoQuality.ceiling()
            let th = CallVideoQuality.thermalLabel
            if th != lastThermal {
                nativeCallDiag("video_thermal", callId, "state=\(th) ceiling=\(ceil.rawValue)")
                lastThermal = th
            }
            let target = CallVideoProfile.ofRank(min(ceil.rank, bwLevel))
            guard target != cur else { return }
            if target.rank > cur.rank && since < 20 { return }
            let cause: String
            if target.rank < cur.rank {
                cause = bwLevel < ceil.rank ? "bandwidth_bars\(score)" : why
            } else {
                cause = target.rank < ceil.rank ? "bandwidth_recovered" : "ceiling_\(why)"
            }
            apply(target, reason: "\(cause)/\(reason)")
        }

        private func apply(_ target: CallVideoProfile, reason: String) {
            guard !applying, canApply(), let r = room else { return }
            lastChangeAt = Date()
            let from = CallVideoQuality.current
            guard let pub = r.localParticipant.videoTracks.first(where: { $0.source == .camera }),
                  let track = pub.track as? LocalVideoTrack,
                  let cap = track.capturer as? CameraCapturer else {
                // No camera yet: the next publish picks the rung up through
                // defaultCameraCaptureOptions() → profile() (adaptiveCapRank).
                CallVideoQuality.current = target
                return
            }
            let position: AVCaptureDevice.Position = cap.position != .unspecified ? cap.position : cap.options.position
            let opts = CameraCaptureOptions(position: position, dimensions: target.dimensions, fps: target.maxFps)
            applying = true
            let cid = callId
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    _ = try await cap.set(options: opts)
                    CallVideoQuality.current = target
                    let net = CallNetworkSnapshot.shared
                    let info = "from=\(from.rawValue) to=\(target.rawValue) reason=\(reason) net=\(net.label) bars=\(self.lastScore) thermal=\(CallVideoQuality.thermalLabel) saver=\(CallVideoQuality.isDataSaver ? 1 : 0) env=\(CallVideoQuality.layersLabel())"
                    print("[VideoQ] video_profile_change \(info)")
                    nativeCallDiag("video_profile_change", cid, info)
                } catch {
                    print("[VideoQ] video profile change failed: \(error)")
                    nativeCallDiag("video_profile_change_failed", cid, "to=\(target.rawValue) err=\(error)")
                }
                await MainActor.run { self.applying = false }
            }
        }
    }

    /// [2026-10-11 full-hd] Receive side: "Economizar dados" → ask the SFU
    /// for the MEDIUM layer (540p of a Full HD sender), else HIGH. LK throws
    /// `invalidState` when adaptiveStream manages the track (1:1 Rooms are
    /// built with adaptiveStream OFF while the saver is on) — ignored.
    static func applyReceivePreference(_ publication: RemoteTrackPublication) {
        guard publication.kind == .video, publication.source == .camera else { return }
        let q: VideoQuality = CallVideoQuality.isDataSaver ? .medium : .high
        Task { try? await publication.set(videoQuality: q) }
    }

    static func applyReceivePreference(room: Room) {
        for rp in room.remoteParticipants.values {
            for case let pub as RemoteTrackPublication in rp.trackPublications.values {
                applyReceivePreference(pub)
            }
        }
    }

    /// [HD tuning 2026-05-26] AudioPublishOptions — Opus voice resilience knobs.
    /// AudioCaptureOptions (above) owns the DSP (AEC/AGC/NS); these own how the
    /// Opus stream is PACKETIZED and made loss-resilient:
    ///   - `dtx: true`  — Discontinuous Transmission: stop sending packets during
    ///     silence (saves uplink, battery; no audible effect).
    ///   - `red: true`  — REDundant audio encoding: piggyback a copy of the prior
    ///     packet so a single/short-burst loss is recovered with zero retransmit
    ///     latency. This is the fix for "voz cortando" on cellular. Overhead is
    ///     negligible at voice bitrates.
    ///   - `encoding.maxBitrate = 48 kbps` — music-grade mono voice headroom
    ///     (Opus sounds full at 32-48k mono; the JS adaptive loop pulls down to
    ///     24-32k only on a genuinely poor link). FEC rides in the Opus SDP.
    /// LK Swift 2.x signature: AudioPublishOptions(name:encoding:dtx:red:).
    static func defaultAudioPublishOptions() -> AudioPublishOptions {
        // NOTE: this LiveKit Swift version's AudioPublishOptions has no `red:`
        // param (it was added in a later SDK). DTX alone is the supported knob;
        // RED is negotiated by the SFU. Adding `red:` is a compile error here.
        return AudioPublishOptions(
            name: nil,
            encoding: AudioEncoding(maxBitrate: 48_000),
            dtx: true
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
        // [2026-10-11 noise] Spelled out (labels/order verified against
        // client-sdk-swift 2.0.18 AudioCaptureOptions.init) so an SDK bump can
        // never silently flip a default. RNNoise runs AFTER these, in the APM
        // capture post-processor (RNNoiseAudioProcessor).
        return AudioCaptureOptions(
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            typingNoiseDetection: true,
            highpassFilter: true
        )
    }

    // MARK: - Deinit

    deinit {
        // [2026-10-07 ios-native] Safety net — the Live Activity also ends on
        // ExpoCallKitNativeCallEnded (CallLiveActivity observes it).
        CallLiveActivity.shared.callEnded(callId: callId)
        // [2026-10-06 screen-share iOS] Darwin observer holds an unretained
        // pointer to the token — drop it before the VC goes away.
        if let tok = broadcastStopToken {
            ScreenShareSupport.stopObserving(tok)
            broadcastStopToken = nil
        }
        if let o = screenSharePendingObserver { NotificationCenter.default.removeObserver(o) }
        if let o = preconnSlowObserver { NotificationCenter.default.removeObserver(o) } // [2026-10-18 calls-data]
        screenShareLandscape?.detach()   // [2026-10-15]
        stopOutgoingCameraPreview() // [2026-10-14 self-view]
        gridHeaderTimer?.invalidate() // [2026-10-14 group-ui]
        if let tok = gridDeclineObserver { NotificationCenter.default.removeObserver(tok) }
        // [minimize-drop fix 2026-05-26] CRITICAL: do NOT disconnect the Room
        // when this dealloc is the result of a MINIMIZE. The incoming-answer
        // path presents this VC as a plain modal, so when handleMinimize() (or
        // the PiP-did-start) dismisses it, the presenting VC drops its only
        // strong ref → ARC deallocs us → deinit runs. Previously this block
        // unconditionally called `room.disconnect()` + `NativeCallRoom.clear()`,
        // which TORE DOWN THE LIVE CALL on minimize (user report: "minimize
        // drops the call; returning shows the call has dropped"). The Room is
        // owned by NativeCallRoom.shared precisely so it survives VC dismissal
        // (PiP / floating-bar). Skip teardown while minimizing; the real hangup
        // (End button → handleHangup, or remote didDisconnect) already
        // disconnects the Room + clears the singleton, and leaves isMinimizing
        // false so this belt-and-braces path still cleans up on those flows.
        peerGoneWork?.cancel(); peerGoneWork = nil
        // [2026-10-12 deinit-guard] Another live CallViewController still drives
        // this exact Room (duplicate present for the same call) → it owns the
        // teardown; disconnecting here would kill its live call. Weak table:
        // `self` is already gone from it while deinit runs.
        let roomSharedWithLiveVC: Bool = {
            guard let r = self.room, Thread.isMainThread else { return false }
            return Self.liveInstances.allObjects.contains { $0.room === r && !$0.didHangup }
        }()
        if roomSharedWithLiveVC {
            nativeCallDiag("call_close_deinit_skip_shared_room", callId)
        } else if let r = self.room, !isMinimizing, !cededToJs {
            // [CALL-CLOSE diag 2026-05-27] The VC deallocated while NOT
            // minimizing/ceding → this tears down the Room. If this fires right
            // after answer, a premature dismiss/double-present dropped the VC's
            // only strong ref (the suspected double-VC teardown). Surfacing it
            // here on the voip_diag log tells us if THIS is the close path.
            nativeCallDiag("call_close_deinit_teardown", callId)
            ExpoCallKitModule.ensureCallKitEnded(callId: callId, src: "callvc_deinit", delay: 1.0) // [2026-10-20 callend-reload]
            P2PCallBridge.close(callId: callId, reason: "deinit") // [2026-10-09 p2p-ios]
            // [#1207 NativeCallRoom REAL] Belt-and-braces: usually handleHangup
            // or didDisconnect have already cleared the singleton by the time
            // deinit runs, but force-quit can short-circuit those. Idempotent —
            // clear() on an already-empty singleton is a no-op print.
            // [2026-10-11 publisher-nil] Scoped to OUR Room (see clear(ifCurrent:)).
            NativeCallRoom.shared.clear(ifCurrent: r, reason: "callvc_deinit")
            LKLeave.leave(r, callId: callId, reason: "callvc_deinit") // [2026-10-14 leave-first]
        } else if isMinimizing || cededToJs {
            print("[CallVC] deinit while \(cededToJs ? "ceding to JS" : "minimizing") — keeping Room alive (owned by NativeCallRoom.shared) callId=\(callId)")
        }
        if let obs = pipResignObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = dtmfObserver { NotificationCenter.default.removeObserver(obs); dtmfObserver = nil }
        if let obs = systemMuteObserver { NotificationCenter.default.removeObserver(obs); systemMuteObserver = nil }
        if let obs = systemHoldObserver { NotificationCenter.default.removeObserver(obs); systemHoldObserver = nil }
        if let obs = avInterruptionObserver { NotificationCenter.default.removeObserver(obs); avInterruptionObserver = nil }
        if let obs = audioActivatedObserver { NotificationCenter.default.removeObserver(obs); audioActivatedObserver = nil }
        // [2026-05-22 #1349 fix] Caller-side ringback teardown observer.
        if let obs = remoteAnsweredObserver { NotificationCenter.default.removeObserver(obs); remoteAnsweredObserver = nil }
        // [2026-10-06 native-only outgoing]
        if let obs = remoteEndObserver { NotificationCenter.default.removeObserver(obs); remoteEndObserver = nil }
        if let obs = peerStatusObserver { NotificationCenter.default.removeObserver(obs); peerStatusObserver = nil }
        if let obs = p2pObserver { NotificationCenter.default.removeObserver(obs); p2pObserver = nil }
        outgoingRingTimer?.cancel(); outgoingRingTimer = nil
        outgoingConnectFallbackTimer?.cancel(); outgoingConnectFallbackTimer = nil
        if #available(iOS 15.0, *), let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        if let track = pipAttachedTrack, let renderer = pipRenderer {
            track.remove(videoRenderer: renderer)
        }
        pipAttachedTrack = nil
        pipStallTimer?.invalidate(); pipStallTimer = nil // [2026-10-14 pip-frozen]
        pipController = nil
        pipVideoCallVC = nil
        pipDisplayLayer = nil
        pipRenderer = nil
        stopRingbackTone(reason: "deinit")
        if let obs = ringbackResignObserver { NotificationCenter.default.removeObserver(obs) }
        // [#1358 video parity 2026-05-25] Tear down the video-mode controls
        // auto-hide timer + detach the video tracks so LK doesn't keep
        // rendering into dead views. Combine cancellables auto-cancel on
        // dealloc; the Timer must be invalidated explicitly.
        controlsHideTimer?.invalidate()
        controlsHideTimer = nil
        remoteVideoView?.track = nil
        localVideoView?.track = nil
        // [Wave B audio, 2026-05-18 / restored 2026-05-19] Belt-and-braces —
        // handleHangup tears down the router on user-initiated end, deinit
        // covers room-disconnect / PiP dismiss paths.
        // [2026-10-07 audio-route] NOT while minimizing / ceding to JS: the
        // call is still live (Room kept by NativeCallRoom.shared) and the
        // router must keep owning LiveKit's audio-session hook, otherwise the
        // next track start falls back to LiveKit's `.videoChat` = loudspeaker.
        // The real end (handleHangup / module endCall paths) tears it down.
        if let obs = audioRouteObserver { NotificationCenter.default.removeObserver(obs); audioRouteObserver = nil }
        if !(isMinimizing || cededToJs) {
            AudioRouter.shared.teardown()
        }
    }

    // MARK: - Presentation helper

    /// [2026-10-18 call-connect-fast] Outgoing screen presented before the
    /// LiveKit token exists: resolve the host(s) the token will most likely
    /// point to (the last one used + the US default) so Room.connect does not
    /// pay a cold DNS lookup on cellular once the token lands
    /// (call_1792267743898_zkca2agc0: signal join took ~0.7 s after the token).
    /// getaddrinfo on a background queue, results discarded (the system
    /// resolver cache keeps them). Never blocks the connect. Kill switch:
    /// App Group bool "chatyy_lk_dns_prewarm_off".
    static func prewarmLkDns(callId: String) {
        let ud = UserDefaults(suiteName: "group.com.onemundo.mail")
        if ud?.bool(forKey: "chatyy_lk_dns_prewarm_off") ?? false { return }
        var hosts: [String] = []
        if let last = ud?.string(forKey: "chatyy_last_lk_host"), !last.isEmpty { hosts.append(last) }
        if !hosts.contains("livekit.chatyy.com.br") { hosts.append("livekit.chatyy.com.br") }
        let hostList = hosts
        DispatchQueue.global(qos: .userInitiated).async {
            for h in hostList {
                let t0 = Date()
                var hints = addrinfo()
                hints.ai_socktype = SOCK_STREAM
                var res: UnsafeMutablePointer<addrinfo>? = nil
                let rc = getaddrinfo(h, "443", &hints, &res)
                if let r = res { freeaddrinfo(r) }
                nativeCallDiag("lk_dns_prewarm", callId, "host=\(h) rc=\(rc) ms=\(Int(Date().timeIntervalSince(t0) * 1000))")
            }
        }
    }

    /// [2026-10-18 call-connect-fast] Host of the LiveKit URL this call connects
    /// to, kept for the next call's DNS prewarm (region rarely changes).
    static func rememberLkHost(_ url: String) {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return }
        UserDefaults(suiteName: "group.com.onemundo.mail")?.set(host, forKey: "chatyy_last_lk_host")
    }

    /// [2026-10-18 caller-warm] CALLER twin of the ring-window warm-up in
    /// preconnectRoom below. LiveKitClient 2.0.18 only negotiates the publisher
    /// PeerConnection at the FIRST publish, so the caller's mic waited for a
    /// full publisher ICE + DTLS after the answer (call_1792267743898_zkca2agc0:
    /// mic reached the SFU 1.66 s after the connect). publish(data:) to our OWN
    /// identity negotiates it now WITHOUT any media: no track, no audio, the
    /// SFU delivers the packet to nobody (ring-leak gate unchanged — the mic is
    /// still published only on answer). Fire-and-forget; idempotent enough
    /// (a 2nd call just sends one more 1-byte packet). Same kill switch as the
    /// callee warm-up: App Group bool "chatyy_warm_publisher_off".
    static func warmPublisherTransport(_ r: Room, callId: String, label: String) {
        if UserDefaults(suiteName: "group.com.onemundo.mail")?.bool(forKey: "chatyy_warm_publisher_off") ?? false { return }
        Task.detached(priority: .userInitiated) {
            guard r.connectionState == .connected, let me = r.localParticipant.identity else {
                nativeCallDiag("\(label)_pub_warm_skip", callId, "lk=\(NativeCallRoom.stateName(r.connectionState))")
                return
            }
            let tWarm = Date()
            do {
                try await r.localParticipant.publish(
                    data: Data([1]),
                    options: DataPublishOptions(destinationIdentities: [me], topic: "chatyy_warm", reliable: true)
                )
                nativeCallDiag("\(label)_pub_warm_ok", callId, "ms=\(Int(Date().timeIntervalSince(tWarm) * 1000))")
            } catch {
                nativeCallDiag("\(label)_pub_warm_err", callId, "ms=\(Int(Date().timeIntervalSince(tWarm) * 1000)) err=\(error)")
            }
        }
    }

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
        // [2026-10-08 call-connect-fast] The check below and the
        // NativeCallRoom.publish further down used to be NON-atomic. Both
        // ring-window kicks (VoIP push + WS-invite UUID reuse) run this from
        // Task.detached threads, so two Rooms could pass the check together →
        // the SFU saw DUPLICATE_IDENTITY, the evicted Room's connect threw and
        // its catch cleared the singleton (which by then pointed at the OTHER,
        // healthy Room) → at answer isPreconnected()==false → CallViewController
        // built a 3rd Room and re-joined from scratch (+1.7-3 s until the caller
        // heard anything; SFU log call_1791387719490 15:42:02/15:42:07).
        // Serialise check-and-publish with a process-wide lock.
        kPreconnectRoomLock.lock()
        // Bail if a Room is already mid-connect for this call (idempotent).
        if NativeCallRoom.shared.isPreconnected(callId: callId) {
            kPreconnectRoomLock.unlock()
            print("[CallVC] preconnectRoom: already pre-connected for \(callId) — skip")
            return
        }
        // Touch the BackgroundProcessor singleton so the first published video
        // frame sees the user's background-blur toggle state. (RNNoise removed
        // 2026-10-04 — never-linked no-op; audio NS = WebRTC + VPIO.)
        _ = BackgroundProcessor.shared
        // [2026-10-07 audio-route] Make sure LiveKit's AudioManager can never
        // run its default (.videoChat / .playback = loudspeaker) configure for
        // this call's tracks — the hook defers to AudioRouter once the answer
        // path claims the session (prepareForCall / configureForCall).
        AudioRouter.installLiveKitAudioHook()
        // [WAVE 115, 2026-05-21] Relay-first ICE — same policy as viewDidLoad path.
        let roomOptions = RoomOptions(
            defaultCameraCaptureOptions: Self.defaultCameraCaptureOptions(),
            defaultAudioCaptureOptions: Self.defaultAudioCaptureOptions(),
            defaultVideoPublishOptions: Self.defaultVideoPublishOptions(),
            // [HD tuning 2026-05-26] DTX + RED on the published Opus stream.
            defaultAudioPublishOptions: Self.defaultAudioPublishOptions(),
            // [2026-10-11 full-hd] OFF with "Economizar dados" → MEDIUM layer pinned.
            adaptiveStream: !CallVideoQuality.isDataSaver,
            dynacast: true,
            // [e2ee5 WP-13] Conversa cifrada (dica do push): o Room do toque já nasce com E2EE,
            // sem chave = quadros descartados até a chave chegar. nil = hoje.
            e2eeOptions: CallE2EE.shared.e2eeOptions(callId: callId),
            // [video-quality 2026-10-06] Track.statistics for the diag beacon.
            reportRemoteTrackStatistics: true
        )
        // delegate: nil — there's no VC yet. CallViewController.viewDidLoad
        // (called when present() lands) will rebind its own RoomDelegate via
        // the singleton's published Room reference. Until then, NativeCallRoom
        // .didConnect forwarders fire via the JS adoptNativeRoom listener bag.
        let r = Room(delegate: nil, roomOptions: roomOptions)
        // [2026-10-11 publisher-nil] Keep url/token so a Room that dies during
        // the ring can be REJOINED on answer (NativeCallRoom.rejoinIfDead).
        NativeCallRoom.shared.publish(room: r, callId: callId, roomName: callId, url: url, token: token)
        // [2026-10-18 calls-data] By-callId registry → the answer can reclaim
        // this Room even if another call repoints the singleton meanwhile.
        NativeCallRoom.shared.registerPreconnect(callId: callId, room: r, url: url, token: token)
        kPreconnectRoomLock.unlock()
        runPreconnectConnect(r, url: url, token: token, callId: callId, attempt: 1)
    }

    /// [2026-10-18 calls-data] Connect body of the ring-window preconnect
    /// (was inline in preconnectRoom; shared with the slow-connect retry).
    private static func runPreconnectConnect(_ r: Room, url: String, token: String, callId: String, attempt: Int) {
        armPreconnectSlowCheck(r, callId: callId, attempt: attempt)
        Task.detached(priority: .userInitiated) {
            do {
                // [CALL-TRACE 2026-05-20 WAVE42] Step 8/12 — iOS dials the
                // LK SFU on the preconnect path. The viewDidLoad async-connect
                // path (~line 365) has its own [8/12] tracer below if used.
                NSLog("[CallTrace][8/12] LK Room.connect roomName=\(callId) serverUrl=\(url) tokenLen=\(token.count) path=preconnect")
                try await r.connect(url: url, token: token, connectOptions: NativeCallTokenFetcher.connectOptions(
                    forToken: token, oneToOne: !NativeCallTokenFetcher.isGroupCall(callId))) // [2026-10-19 chamada-queda]
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
                // [chamadas-atender 2026-10-15] AQUECE o publisher PC durante o toque (paridade WhatsApp:
                // ICE/DTLS de envio prontos ANTES de atender). SDK 2.0.18 ignora JoinResponse.fast_publish e
                // só negocia o publisher no 1º publish → no atender, o mic esperava um 2º ICE inteiro (campo
                // 15/10: callee BR em 4G IPv6 levou +4 s só nisso; caller ouviu ~12 s depois do "atender").
                // publish(data:) força a negociação SEM mídia; destino = a própria identidade → o SFU não
                // entrega a ninguém (sem fantasma no outro lado, #1330 continua valendo: mic só no atender).
                // Desligar sem build: App Group bool "chatyy_warm_publisher_off" = true.
                if !(UserDefaults(suiteName: "group.com.onemundo.mail")?.bool(forKey: "chatyy_warm_publisher_off") ?? false),
                   let me = r.localParticipant.identity {
                    let tWarm = Date()
                    do {
                        try await r.localParticipant.publish(
                            data: Data([1]),
                            options: DataPublishOptions(destinationIdentities: [me], topic: "chatyy_warm", reliable: true)
                        )
                        nativeCallDiag("preconnect_pub_warm_ok", callId, "ms=\(Int(Date().timeIntervalSince(tWarm) * 1000))")
                    } catch {
                        nativeCallDiag("preconnect_pub_warm_err", callId, "ms=\(Int(Date().timeIntervalSince(tWarm) * 1000)) err=\(error)")
                    }
                }
            } catch {
                NSLog("[CallTrace][8b/12] LK Room connect FAILED err=\(error) (path=preconnect)")
                print("[CallVC] preconnectRoom: failed callId=\(callId) err=\(error)")
                // [2026-10-08 call-connect-fast] Only drop the singleton if it
                // still points at THIS Room — never clobber a newer/healthy one.
                if NativeCallRoom.shared.currentRoom() === r {
                    NativeCallRoom.shared.clear()
                } else {
                    nativeCallDiag("preconnect_failed_not_current", callId, "\(error)")
                }
                NativeCallRoom.shared.unregisterPreconnect(callId: callId, room: r) // [2026-10-18 calls-data]
            }
        }
    }

    // MARK: - [2026-10-18 calls-data] Slow ring-window preconnect

    /// Notification posted when an ANSWERED call's adopted Room is still not
    /// connected after `preconn_retry_s` (userInfo["callId"]). The call screen
    /// shows "Sem conexão — tentando…" instead of a silent "Conectando…".
    static let preconnectSlowNotification = Notification.Name("ChatyyPreconnectSlow")

    /// Field 17/10 13:11Z: 5 callee preconnects stuck "connecting" (−1001
    /// timeout) — the answer adopted a Room that never connected and the user
    /// sat on "Conectando…" until the 8 s watchdog. After `preconn_retry_s`
    /// (default 3) without .connected:
    ///   - still ringing → retry ONCE with a FRESH token (the server may pick
    ///     another region/node): new Room published + registered, then the
    ///     stuck one LEAVEs (never two joins with one identity at once);
    ///   - already answered → never touch the adopted Room (a forced reconnect
    ///     ends the call); just tell the screen.
    private static func armPreconnectSlowCheck(_ r: Room, callId: String, attempt: Int) {
        let delay = CallResilience.flags().preconnRetryS
        guard delay > 0, attempt <= 2 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard NativeCallRoom.shared.currentRoom() === r,
                  NativeCallRoom.shared.currentCallId() == callId else { return }
            let st = r.connectionState
            if st == .connected { return }
            if NativeCallRoom.shared.isAnsweredIncoming(callId: callId) {
                nativeCallDiag("preconnect_slow_answered", callId, "attempt=\(attempt) lk=\(NativeCallRoom.stateName(st)) after_s=\(Int(delay))")
                NotificationCenter.default.post(name: CallViewController.preconnectSlowNotification, object: nil, userInfo: ["callId": callId])
                return
            }
            guard attempt == 1, !IncomingCallFilter.isFiltered(callId) else { return }
            nativeCallDiag("preconnect_slow_retry", callId, "lk=\(NativeCallRoom.stateName(st)) after_s=\(Int(delay))")
            CallViewController.retryPreconnectFresh(stuck: r, callId: callId)
        }
    }

    private static func retryPreconnectFresh(stuck: Room, callId: String) {
        let identity = UserDefaults(suiteName: "group.com.onemundo.mail")?.string(forKey: "user_email") ?? ""
        Task.detached(priority: .userInitiated) {
            let t0 = Date()
            let fresh: (url: String, token: String)
            do {
                let tok = try await NativeCallTokenFetcher.shared.fetchToken(
                    roomName: callId, identity: identity.isEmpty ? callId : identity, role: "publisher")
                fresh = (url: tok.url, token: tok.token)
            } catch {
                nativeCallDiag("preconnect_retry_token_failed", callId, "err=\(error)")
                return
            }
            await MainActor.run {
                // Answered / cancelled / connected / replaced meanwhile → keep it.
                kPreconnectRoomLock.lock()
                guard NativeCallRoom.shared.currentRoom() === stuck,
                      stuck.connectionState != .connected,
                      !NativeCallRoom.shared.isAnsweredIncoming(callId: callId),
                      !IncomingCallFilter.isFiltered(callId),
                      !voipCallIdRecentlyEnded(callId) else {
                    kPreconnectRoomLock.unlock()
                    nativeCallDiag("preconnect_retry_skipped", callId, "lk=\(NativeCallRoom.stateName(stuck.connectionState))")
                    return
                }
                let r2 = Room(delegate: nil, roomOptions: RoomOptions(
                    defaultCameraCaptureOptions: Self.defaultCameraCaptureOptions(),
                    defaultAudioCaptureOptions: Self.defaultAudioCaptureOptions(),
                    defaultVideoPublishOptions: Self.defaultVideoPublishOptions(),
                    defaultAudioPublishOptions: Self.defaultAudioPublishOptions(),
                    adaptiveStream: !CallVideoQuality.isDataSaver,
                    dynacast: true,
                    // [e2ee5 WP-13 2026-10-22] O Room de reserva TAMBÉM nasce com E2EE quando a ligação é
                    // exigida (antes saía sem e2eeOptions → atender por cima dele publicava áudio em claro).
                    e2eeOptions: CallE2EE.shared.e2eeOptions(callId: callId),
                    reportRemoteTrackStatistics: true
                ))
                NativeCallRoom.shared.publish(room: r2, callId: callId, roomName: callId, url: fresh.url, token: fresh.token)
                NativeCallRoom.shared.registerPreconnect(callId: callId, room: r2, url: fresh.url, token: fresh.token)
                kPreconnectRoomLock.unlock()
                if let ud = UserDefaults(suiteName: "group.com.onemundo.mail") {
                    ud.set(fresh.token, forKey: "lk_token_\(callId)")
                    ud.set(fresh.url, forKey: "lk_url_\(callId)")
                }
                nativeCallDiag("preconnect_retry_start", callId,
                               "tokenMs=\(Int(Date().timeIntervalSince(t0) * 1000)) host=\(URL(string: fresh.url)?.host ?? "-")")
                // The stuck Room leaves FIRST; the fresh one joins right after.
                LKLeave.leave(stuck, callId: callId, reason: "preconnect_slow_retry", timeout: 0.8) {
                    CallViewController.runPreconnectConnect(r2, url: fresh.url, token: fresh.token, callId: callId, attempt: 2)
                }
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
        conversationId: String = "",
        replacingStale: Bool = false
    ) {
        CallDiagRole.set(callId, isOutgoing ? "caller" : "callee") // [2026-10-18 calls-data]
        // [2026-10-09 native-group-call] A CallKit-answered GROUP call gets the
        // native N-way screen (GroupCallViewController adopts the preconnected
        // Room) instead of this 1:1 UI. Gated by the App Group flag JS sets
        // from NATIVE_GROUP_CALL_UI (off → unchanged behavior).
        if !isOutgoing && GroupCallViewController.shouldPresentNativeGroup(callId: callId) {
            nativeCallDiag("callvc_reroute_group", callId)
            GroupCallViewController.presentIncoming(
                from: base,
                callId: callId,
                hasVideo: hasVideo,
                lkUrl: lkUrl ?? "",
                lkToken: lkToken ?? "",
                conversationId: conversationId
            )
            return
        }
        let top = topMostViewController(from: base)
        // [2026-05-25] Dedup guard. Now that BOTH the cold-start stub and the
        // warm-app path present for VoIP-push calls (the module-bound bail was
        // removed because the module never actually presented), guarantee we
        // never stack two CallViewControllers for the same call. Reads the live
        // presented-VC chain (no stored state that could go stale), so it's
        // self-correcting across call lifecycles.
        if let existing = existingCallVC(from: base), existing.callId == callId {
            NSLog("[CallVC.present] already presenting callId=\(callId) — skipping duplicate")
            nativeCallDiag("callvc_present_dedup_skip", callId)
            // [2026-10-15 call-open-fast] The outgoing screen went up before the
            // token existed; this later present (CXStartCallAction fetch) carries
            // it → hand it to the live screen so its Room connects now.
            if isOutgoing, let u = lkUrl, let t = lkToken, !u.isEmpty, !t.isEmpty {
                existing.supplyLateToken(url: u, token: t, source: "present_dedup")
            }
            return
        }
        // [2026-10-12 stacked-callvc] A CallViewController of ANOTHER call is
        // still on screen (redial / glare / answer of a 2nd call while the
        // previous screen shows "Encerrada"). Presenting on top of it was
        // fatal: when the old VC later dismissed itself, UIKit dismissed the
        // NEW call's VC (the child above it) → deinit → Room disconnect
        // (call_1791817895316_lkdicey1a: caller left 208 ms after media; 4×
        // "top=CallViewController" in 72 h). With maximumCallGroups=1 the old
        // call is already ending, so replace it: dismiss the old stack without
        // animation, then present the new call from its presenter.
        if !replacingStale,
           let stale = existingCallVC(from: base), stale.callId != callId,
           let presenter = stale.presentingViewController {
            nativeCallDiag("callvc_replace_stale", callId, "stale=\(stale.callId) staleHungUp=\(stale.didHangup)")
            // Old call still "live" on this screen → tell its peer it ended
            // (WS call_end only). NOT handleHangup: its CallKit "end ALL
            // calls" fallback would also end the call being presented now.
            // The Room goes with the old VC's deinit (scoped clear).
            if !stale.didHangup {
                stale.didHangup = true
                stale.peerGoneWork?.cancel(); stale.peerGoneWork = nil
                CallSignalWs.shared.fireCallEnd(
                    callId: stale.callId,
                    conversationId: stale.conversationId,
                    reason: "replaced_by_new_call",
                    targetEmail: stale.callerEmail
                )
            }
            // Old call's Room leaves now (not only when/if the VC deallocs).
            // Scoped: clear(ifCurrent:) never touches the new call's Room.
            if let oldRoom = stale.room {
                NativeCallRoom.shared.clear(ifCurrent: oldRoom, reason: "callvc_replaced")
                LKLeave.leave(oldRoom, callId: stale.callId, reason: "replaced_by_new_call") // [2026-10-14 leave-first]
            }
            let presentNew = {
                // Idempotent: the dedup guard at the top skips a 2nd present
                // once the new VC is in the chain.
                CallViewController.present(from: base, callId: callId, callerName: callerName, callerEmail: callerEmail,
                        hasVideo: hasVideo, lkUrl: lkUrl, lkToken: lkToken, isOutgoing: isOutgoing,
                        conversationId: conversationId, replacingStale: true)
            }
            presenter.dismiss(animated: false) { presentNew() }
            // UIKit drops a dismiss requested mid-transition WITHOUT calling the
            // completion — never leave the new call without a screen.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { presentNew() }
            return
        }
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

    /// [2026-05-25] Walk the presented-VC chain looking for a live
    /// CallViewController so present() can dedup. Returns nil if none on screen.
    private static func existingCallVC(from base: UIViewController) -> CallViewController? {
        var node: UIViewController? = base
        while let cur = node {
            if let call = cur as? CallViewController, !cur.isBeingDismissed {
                return call
            }
            node = cur.presentedViewController
        }
        return nil
    }

    /// [2026-05-25] Dismiss the native call screen. JS calls this via
    /// ExpoCallKit.dismissNativeCallVC() once /call.js has mounted + adopted the
    /// pre-connected room — the rich JS UI replaces this instant native
    /// placeholder. Animated:false so the handoff is seamless (no flash). The
    /// native screen is the "floor": if JS never mounts (cold-start that fails),
    /// it stays up, so this is purely additive — never a regression.
    @objc static func dismissIfPresented() {
        DispatchQueue.main.async {
            guard let root = resolvePresentingViewController() else { return }
            if let vc = existingCallVC(from: root) {
                nativeCallDiag("callvc_dismiss_for_js", vc.callId)
                // [FIX 2026-06-30 iPhone→Android "conectado fantasma"] Mark the
                // Room as ceded to JS BEFORE dismissing. Without this, the JS
                // handoff dismiss → ARC dealloc → deinit (~line 2692) takes the
                // `!cededToJs` branch and runs r.disconnect() on the LIVE caller
                // Room → CLIENT_REQUEST_LEAVE ~1s after the caller joined, before
                // the callee answered (proven in the SFU log). cededToJs was
                // declared for exactly this handoff but never assigned anywhere;
                // setting it routes deinit to the keep-alive branch (Room stays
                // owned by NativeCallRoom.shared / driven by JS). Real hangup
                // still disconnects via handleHangup, which clears flags first.
                vc.cededToJs = true
                // [2026-10-06 native-only outgoing] An OLD JS bundle (legacy
                // adopt + dismissNativeCallVC on the CALLER) is tearing this VC
                // down before the callee answered. The ring-leak mic gate lived
                // on this VC, so nobody would ever publish the caller's mic
                // ("caller silent", SFU logs 2026-10-05). Hand the gate to the
                // Room-owning singleton so the mic/camera still go out on answer.
                if vc.isOutgoing && !vc.outgoingMicGateOpen {
                    vc.cancelOutgoingRingTimer()
                    vc.cancelOutgoingConnectFallback()
                    NativeCallRoom.shared.armOutgoingPublishOnAnswer(
                        callId: vc.callId,
                        hasVideo: vc.hasVideo,
                        micDesired: vc.session.micEnabled
                    )
                }
                vc.dismiss(animated: false, completion: nil)
            }
        }
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

    // [UI rewrite 2026-05-25] Minimize chevron → PiP / floating bar. Delegates
    // to the existing handleMinimize() plumbing (PiP when supported, else the
    // OngoingCallBar overlay + dismiss). NOT hangup.
    @objc private func uikitOnMinimizeTap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        handleMinimize()
    }

    // [2026-10-11 ongoing-call] "Mensagem": minimize + open this person's chat.
    @objc private func uikitOnMessageTap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        tapFeedback(view.viewWithTag(9008) as? UIButton)
        openChat()
    }

    // [UI rewrite 2026-05-25] Active-state tint for a glass control button:
    // "active" (muted / cam-off / speaker-on) brightens the overlay; the
    // default state is the subtle translucent white. The overlay is the
    // subview inserted just above the blur in glassButton(). Icon point size
    // matches the initial render (~size*0.36, semibold).
    private func setControlActive(_ btn: UIButton?, active: Bool, symbol: String) {
        guard let btn = btn else { return }
        let side = btn.bounds.width > 0 ? btn.bounds.width : 64
        let cfg = UIImage.SymbolConfiguration(pointSize: side * 0.36, weight: .semibold)
        btn.setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
        // overlay = the tint view tagged 7 inside glassButton().
        let overlay = btn.subviews.first { $0.tag == 7 }
        UIView.animate(withDuration: 0.18) {
            overlay?.backgroundColor = active
                ? UIColor.white.withAlphaComponent(0.92)
                : UIColor.white.withAlphaComponent(0.16)
            btn.tintColor = active ? UIColor.black : .white // [2026-10-16 P&B] era #141022
        }
    }

    @objc private func uikitOnMuteTap() {
        // session.micEnabled = mic ENABLED. Mute = micEnabled false.
        //
        // [2026-05-26 mute→unmute P0 fix v2] Toggle off the REAL current track
        // state, not the cached SwiftUI bool. `session.micEnabled` can drift out
        // of sync with the actual LiveKit publication — a CallKit
        // CXSetMutedCallAction, an AVAudioSession-interruption recovery (which
        // clears localAudioTrackRef), or a previously-failed async toggle can
        // all leave the @Published flag pointing the wrong way. When that
        // happens `!session.micEnabled` computes the SAME direction twice and
        // the user taps "Unmute" but we re-issue MUTE → mic stays off forever.
        //
        // LocalParticipant.isMicrophoneEnabled reflects the publication's true
        // muted state, so derive the next state from there and fall back to the
        // cached bool only when the Room isn't available yet.
        let currentEnabled: Bool
        if let r = self.room {
            currentEnabled = r.localParticipant.isMicrophoneEnabled()
        } else {
            currentEnabled = session.micEnabled
        }
        let newMicEnabled = !currentEnabled
        // Commit the new intended state to the SwiftUI session SYNCHRONOUSLY,
        // BEFORE the async applyMicEnabled round-trip, so the button reflects the
        // tap immediately. applyMicEnabled awaits setMicrophone(enabled:) and
        // only rolls this back if LiveKit genuinely throws.
        session.micEnabled = newMicEnabled
        applyMicEnabled(newMicEnabled)
        syncCallKitMuted(!newMicEnabled)
        let btn = view.viewWithTag(9002) as? UIButton
        tapFeedback(btn)
        // Active (filled) when MUTED.
        setControlActive(btn, active: !newMicEnabled, symbol: newMicEnabled ? "mic.fill" : "mic.slash.fill")
    }

    @objc private func uikitOnSpeakerTap() {
        // [2026-10-06 native-only outgoing] User chose a route — stop the
        // earpiece re-assert in didSubscribeTrack from fighting them.
        speakerTouchedByUser = true
        // [2026-10-09 route-picker] AirPods / BT / CarPlay / wired available →
        // WhatsApp-style output sheet (iPhone · Alto-falante · device).
        if AudioRouter.shared.hasSelectableExternalRoute(), presentedViewController == nil {
            presentAudioRouteSheet(from: view.viewWithTag(9003) as? UIButton)
            return
        }
        let next = !session.speakerOn
        applySpeaker(next)
        let btn = view.viewWithTag(9003) as? UIButton
        tapFeedback(btn)
        // Active (filled) when speaker is ON.
        setControlActive(btn, active: next, symbol: next ? "speaker.wave.2.fill" : "speaker.slash.fill")
    }

    @objc private func uikitOnVideoToggle() {
        // [2026-07-15] Re-entrancy guard — setCamera/mute/unmute inside
        // applyCamEnabled are ASYNC; a 2nd tap while the 1st is in-flight fired
        // overlapping LiveKit camera ops that raced and left the camera STUCK
        // (founder: "camera stucks when trying to on and off"). Ignore taps
        // until the current toggle settles (applyCamEnabled clears the flag
        // when its Task finishes, incl. the room-nil early return).
        guard !isTogglingCamera else { return }
        isTogglingCamera = true
        let desired = !session.camEnabled
        let btn = view.viewWithTag(9005) as? UIButton
        tapFeedback(btn)
        nativeCallDiag("camera_toggle", callId, "on=\(desired ? 1 : 0) video_call=\(hasVideo ? 1 : 0) track=\(session.localVideoTrack != nil ? 1 : 0) room=\(room != nil ? 1 : 0)")
        // [2026-10-15 cam-1-toque] Camera permission gate: 1st time asks and,
        // when granted, CONTINUES the same tap (camera turns on — no 2nd tap).
        // Denied → the button never lights up; offer Settings instead.
        if desired {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                break
            case .notDetermined:
                // Immediate feedback while the system prompt is up.
                setControlActive(btn, active: true, symbol: "video.fill")
                AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        nativeCallDiag("camera_permission", self.callId, "granted=\(granted ? 1 : 0)")
                        if granted && !self.didHangup {
                            self.commitCameraToggle(true)
                        } else {
                            self.isTogglingCamera = false
                            self.setControlActive(self.view.viewWithTag(9005) as? UIButton, active: false, symbol: "video.slash.fill")
                        }
                    }
                }
                return
            default: // .denied / .restricted
                isTogglingCamera = false
                nativeCallDiag("camera_permission", callId, "denied=1")
                presentCameraDeniedAlert()
                return
            }
        }
        commitCameraToggle(desired)
    }

    /// [2026-10-15 cam-1-toque] The actual on/off once permission is settled.
    /// Main thread; caller already holds `isTogglingCamera`.
    private func commitCameraToggle(_ desired: Bool) {
        session.camEnabled = desired
        if desired { dismissVideoRequestPrompt(animated: true) }
        reportCallKitHasVideo(desired)
        applyCamEnabled(desired)
        // [2026-10-07 audio-route] Camera on → loudspeaker (unless the user
        // picked a route) + proximity sensor off; camera off → back.
        AudioRouter.shared.setLocalVideoActive(desired)
        // Active (filled) when the camera is ON.
        setControlActive(view.viewWithTag(9005) as? UIButton, active: desired, symbol: desired ? "video.fill" : "video.slash.fill")
    }

    // MARK: - [2026-10-15 founder] Peer asked for video → Aceitar / Recusar

    private var videoRequestCard: UIView?
    private var videoRequestDismissWork: DispatchWorkItem?

    private func presentVideoRequestPrompt() {
        dismissVideoRequestPrompt(animated: false)
        let who = callerName.isEmpty ? callerEmail : callerName
        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        card.layer.cornerRadius = 20
        card.alpha = 0
        card.transform = CGAffineTransform(translationX: 0, y: 24)

        let title = UILabel()
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = who.isEmpty ? CallStrings.s("videoReqTitleNoName") : CallStrings.s("videoReqTitle", ["name": who])
        title.textColor = .white
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textAlignment = .center
        title.numberOfLines = 2
        card.addSubview(title)

        func pill(_ text: String, filled: Bool, action: Selector) -> UIButton {
            let b = UIButton(type: .system)
            b.translatesAutoresizingMaskIntoConstraints = false
            b.setTitle(text, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            b.setTitleColor(filled ? .white : .black, for: .normal)
            b.backgroundColor = filled
                ? UIColor(red: 0x25/255.0, green: 0xD3/255.0, blue: 0x66/255.0, alpha: 1)
                : UIColor.white
            b.layer.cornerRadius = 20
            b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 22, bottom: 10, right: 22)
            b.addTarget(self, action: action, for: .touchUpInside)
            return b
        }
        let decline = pill(CallStrings.s("videoReqDecline"), filled: false, action: #selector(videoRequestDeclineTap))
        let accept = pill(CallStrings.s("videoReqAccept"), filled: true, action: #selector(videoRequestAcceptTap))
        let row = UIStackView(arrangedSubviews: [decline, accept])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.axis = .horizontal
        row.spacing = 16
        row.distribution = .fillEqually
        card.addSubview(row)

        view.addSubview(card)
        let bar = view.viewWithTag(9008)
        var cons: [NSLayoutConstraint] = [
            card.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            card.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            title.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            title.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            title.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            row.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
            row.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
            row.leadingAnchor.constraint(greaterThanOrEqualTo: card.leadingAnchor, constant: 16),
        ]
        if let bar = bar {
            cons.append(card.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -20))
        } else {
            cons.append(card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -160))
        }
        NSLayoutConstraint.activate(cons)
        view.bringSubviewToFront(card)
        videoRequestCard = card
        // Controls must stay visible while the question is up (video mode
        // auto-hides them after 5 s).
        controlsHideTimer?.invalidate()
        setControlsHidden(false, animated: true)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.5, options: [.allowUserInteraction]) {
            card.alpha = 1
            card.transform = .identity
        }
        let work = DispatchWorkItem { [weak self] in self?.dismissVideoRequestPrompt(animated: true) }
        videoRequestDismissWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }

    private func dismissVideoRequestPrompt(animated: Bool) {
        videoRequestDismissWork?.cancel()
        videoRequestDismissWork = nil
        guard let card = videoRequestCard else { return }
        videoRequestCard = nil
        if animated {
            UIView.animate(withDuration: 0.2, animations: { card.alpha = 0 }) { _ in card.removeFromSuperview() }
        } else {
            card.removeFromSuperview()
        }
        resetControlsAutoHide()
    }

    @objc private func videoRequestAcceptTap() {
        dismissVideoRequestPrompt(animated: true)
        nativeCallDiag("video_request_answer", callId, "accept=1")
        sendVideoRequest(action: "accepted")
        // Same flow as a tap on "Vídeo" (permission 1st time → camera on,
        // loudspeaker rule). Toggle only if it's really off.
        if !session.camEnabled { uikitOnVideoToggle() }
    }

    @objc private func videoRequestDeclineTap() {
        dismissVideoRequestPrompt(animated: true)
        nativeCallDiag("video_request_answer", callId, "accept=0")
        sendVideoRequest(action: "declined")
    }

    /// [2026-10-15 founder] CallKit reflects the voice→video upgrade (Recents
    /// entry / system UI). Only for calls that started as voice. Dual-fire on
    /// both providers like the end paths (unknown UUID = harmless no-op).
    private func reportCallKitHasVideo(_ on: Bool) {
        guard !hasVideo, let uuid = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId) else { return }
        let update = CXCallUpdate()
        update.hasVideo = on
        ExpoCallKitModule.sharedProvider?.reportCall(with: uuid, updated: update)
        if let p = VoipPushAppDelegateSubscriber.earlyProvider, p !== ExpoCallKitModule.sharedProvider {
            p.reportCall(with: uuid, updated: update)
        }
    }

    /// [2026-10-15 cam-1-toque] Camera access denied in iOS Settings — the
    /// toggle can't work; say so and offer the Settings shortcut.
    private func presentCameraDeniedAlert() {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: CallStrings.s("camDeniedTitle"),
                                      message: CallStrings.s("camDeniedBody"),
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: CallStrings.s("cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: CallStrings.s("openSettings"), style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        })
        present(alert, animated: true)
    }

    // [#1358 video parity 2026-05-25] "More" action sheet — re-wires the
    // existing native call tools that the dead SwiftUI CallView used to surface.
    // Every action here calls a method that ALREADY exists on this VC; no new
    // native infra is introduced. Reactions open a nested emoji sheet.
    @objc private func uikitOnMoreTap() {
        tapFeedback(view.viewWithTag(9007) as? UIButton)
        resetControlsAutoHide()
        presentMoreMenu()
    }

    // MARK: - Custom "Mais opções" overlay (2026-10-05)
    //
    // Replaces the washed-out system UIAlertController(.actionSheet) with a
    // dark, rounded floating card that matches the call screen's identity
    // (fundo ~#141F27, SF Symbols in tinted circles, spring entrance). Pure
    // UIKit — mirrors the glass-button / Auto-Layout anchor patterns used by
    // the control bar above. EVERY row re-wires the exact same existing method
    // the old action sheet called (presentReactionPicker / toggleScreenShare /
    // cycleBackground / session.onHold toggle + applyHold / handleAddMember);
    // no new call infra is introduced. Tap outside the card = close.
    private func presentMoreMenu() {
        // Don't stack a second copy if it's already up.
        guard moreMenuBackdrop == nil else { return }

        // Dimmed backdrop over the whole call screen. Tap outside the card
        // closes the menu. The card is a SIBLING above the backdrop (not a
        // child), so hit-testing routes taps on the card to the card and the
        // backdrop's gesture only fires for taps on the darkened area.
        let backdrop = UIView()
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        backdrop.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        backdrop.alpha = 0
        view.addSubview(backdrop)
        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: view.topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            backdrop.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissMoreMenu))
        backdrop.addGestureRecognizer(dismissTap)
        moreMenuBackdrop = backdrop

        // Dark rounded card, floating above the bottom safe area.
        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = UIColor(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0, alpha: 1.0) // [2026-10-16 P&B] era #141F27
        card.layer.cornerRadius = 24
        card.clipsToBounds = false
        card.layer.borderWidth = 0.5
        card.layer.borderColor = UIColor.white.withAlphaComponent(0.08).cgColor
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.5
        card.layer.shadowRadius = 24
        card.layer.shadowOffset = CGSize(width: 0, height: 8)
        card.alpha = 0
        view.addSubview(card)
        moreMenuCard = card

        // Grabber handle (decorative, matches the system sheet affordance).
        let grabber = UIView()
        grabber.translatesAutoresizingMaskIntoConstraints = false
        grabber.backgroundColor = UIColor.white.withAlphaComponent(0.25)
        grabber.layer.cornerRadius = 2.5
        card.addSubview(grabber)

        let header = UILabel()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.text = CallStrings.s("moreOptions")
        header.textColor = .white
        header.font = .systemFont(ofSize: 18, weight: .semibold)
        header.textAlignment = .center
        card.addSubview(header)

        // Rows — the screen-share + hold rows reflect current state (title +
        // symbol), exactly like the old action sheet did.
        let shareTitle  = CallStrings.s(screenSharing ? "stopSharing" : "shareScreen")
        let shareSymbol = screenSharing ? "stop.circle" : "rectangle.on.rectangle"
        let holdTitle   = CallStrings.s(session.onHold ? "resume" : "hold")
        let holdSymbol  = session.onHold ? "play.fill" : "pause.fill"

        // [2026-10-11 call-parity] "Efeito de fundo" REMOVED (iOS + Android):
        // LiveKitClient 2.0.18 has no camera VideoProcessor hook, so
        // BackgroundProcessorLKAdapter.bind() was always a no-op ("skipped") —
        // the row only flipped a flag and the peer never saw any blur. Same
        // order/rows as Android CallActivity's MoreOptionsSheet.
        var rows: [UIButton] = [
            moreMenuRow(symbol: "face.smiling",         title: CallStrings.s("reactions"),      tag: 9071, action: #selector(moreMenuReactions)),
            moreMenuRow(symbol: shareSymbol,            title: shareTitle,                      tag: 9072, action: #selector(moreMenuScreenShare)),
            moreMenuRow(symbol: holdSymbol,             title: holdTitle,                       tag: 9074, action: #selector(moreMenuHold)),
            moreMenuRow(symbol: "person.badge.plus",    title: CallStrings.s("addParticipant"), tag: 9075, action: #selector(moreMenuAddMember)),
        ]
        // [2026-10-11 full-hd] "Economizar dados" replaces "Qualidade HD" (same
        // slot as Android). No manual resolution — Full HD adaptive is automatic;
        // this mirrors Configurações › "Usar menos dados em chamadas".
        // [2026-10-16 wave13-B efeitos] "Efeitos" (fundo + luz) — real now:
        // CallFx taps the camera output (LK 2.0.18 has no VideoProcessor).
        if CallFx.shared.isEnabled && (hasVideo || session.camEnabled) {
            rows.insert(moreMenuRow(symbol: "wand.and.stars", title: CallFxStrings.s("title"),
                                    tag: 9073, action: #selector(moreMenuEffects)), at: 0)
        }
        if hasVideo || session.camEnabled {
            let saver = CallVideoQuality.isDataSaver
            rows.append(moreMenuRow(symbol: saver ? "checkmark.circle.fill" : "arrow.down.circle",
                                    title: CallStrings.s(saver ? "dataSaverOn" : "dataSaver"),
                                    tag: 9076, action: #selector(moreMenuToggleDataSaver)))
        }
        let rowStack = UIStackView(arrangedSubviews: rows)
        rowStack.translatesAutoresizingMaskIntoConstraints = false
        rowStack.axis = .vertical
        rowStack.spacing = 4
        card.addSubview(rowStack)

        NSLayoutConstraint.activate([
            // Card floats with side insets, pinned just above the safe-area bottom.
            card.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            card.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -10),
            card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),

            grabber.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            grabber.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            grabber.widthAnchor.constraint(equalToConstant: 40),
            grabber.heightAnchor.constraint(equalToConstant: 5),

            header.topAnchor.constraint(equalTo: grabber.bottomAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            header.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),

            rowStack.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 14),
            rowStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 10),
            rowStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
            rowStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
        ])

        // Spring/fade entrance (slide up from +40pt), mirroring the tactile
        // animation style the control buttons use via tapFeedback().
        view.layoutIfNeeded()
        card.transform = CGAffineTransform(translationX: 0, y: 40)
        UIView.animate(withDuration: 0.28, delay: 0,
                       usingSpringWithDamping: 0.85, initialSpringVelocity: 0.6,
                       options: [.allowUserInteraction, .curveEaseOut], animations: {
            backdrop.alpha = 1
            card.alpha = 1
            card.transform = .identity
        })
    }

    /// One menu row: a round tinted SF-Symbol glyph + a white title, with a
    /// press highlight. Returned as a UIButton so the row's whole area is
    /// tappable. Subviews disable interaction so taps always reach the button.
    private func moreMenuRow(symbol: String, title: String, tag: Int, action: Selector) -> UIButton {
        let btn = UIButton(type: .custom)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.tag = tag
        btn.layer.cornerRadius = 12
        btn.clipsToBounds = true
        btn.backgroundColor = UIColor.white.withAlphaComponent(0.05)
        btn.addTarget(self, action: action, for: .touchUpInside)
        btn.addTarget(self, action: #selector(moreRowTouchDown(_:)), for: [.touchDown, .touchDragEnter])
        btn.addTarget(self, action: #selector(moreRowTouchUp(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        btn.heightAnchor.constraint(equalToConstant: 56).isActive = true

        let iconWrap = UIView()
        iconWrap.translatesAutoresizingMaskIntoConstraints = false
        iconWrap.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        iconWrap.layer.cornerRadius = 18
        iconWrap.isUserInteractionEnabled = false
        btn.addSubview(iconWrap)

        let icon = UIImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .white
        icon.contentMode = .center
        let cfg = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        icon.image = UIImage(systemName: symbol, withConfiguration: cfg)
        icon.isUserInteractionEnabled = false
        iconWrap.addSubview(icon)

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = title
        label.textColor = .white
        label.font = .systemFont(ofSize: 16, weight: .medium)
        label.isUserInteractionEnabled = false
        btn.addSubview(label)

        NSLayoutConstraint.activate([
            iconWrap.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 10),
            iconWrap.centerYAnchor.constraint(equalTo: btn.centerYAnchor),
            iconWrap.widthAnchor.constraint(equalToConstant: 36),
            iconWrap.heightAnchor.constraint(equalToConstant: 36),

            icon.centerXAnchor.constraint(equalTo: iconWrap.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconWrap.centerYAnchor),

            label.leadingAnchor.constraint(equalTo: iconWrap.trailingAnchor, constant: 14),
            label.centerYAnchor.constraint(equalTo: btn.centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: btn.trailingAnchor, constant: -14),
        ])
        return btn
    }

    @objc private func moreRowTouchDown(_ sender: UIButton) {
        UIView.animate(withDuration: 0.12) {
            sender.backgroundColor = UIColor.white.withAlphaComponent(0.14)
        }
    }

    @objc private func moreRowTouchUp(_ sender: UIButton) {
        UIView.animate(withDuration: 0.2) {
            sender.backgroundColor = UIColor.white.withAlphaComponent(0.05)
        }
    }

    /// Animate the overlay out and remove both views. Safe to call when
    /// nothing is up (guard). Also used as the backdrop tap-to-dismiss target.
    @objc private func dismissMoreMenu() {
        guard let backdrop = moreMenuBackdrop else { return }
        let card = moreMenuCard
        moreMenuBackdrop = nil
        moreMenuCard = nil
        UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseIn], animations: {
            backdrop.alpha = 0
            card?.alpha = 0
            card?.transform = CGAffineTransform(translationX: 0, y: 40)
        }, completion: { _ in
            card?.removeFromSuperview()
            backdrop.removeFromSuperview()
        })
    }

    // Row actions — each closes the menu, then calls the SAME existing method
    // the old action sheet invoked. Wiring preserved exactly.
    @objc private func moreMenuReactions() {
        tapFeedback(view.viewWithTag(9071) as? UIButton)
        dismissMoreMenu()
        presentReactionPicker()
    }
    @objc private func moreMenuScreenShare() {
        tapFeedback(view.viewWithTag(9072) as? UIButton)
        dismissMoreMenu()
        toggleScreenShare()
    }
    @objc private func moreMenuBackground() {
        tapFeedback(view.viewWithTag(9073) as? UIButton)
        dismissMoreMenu()
        cycleBackground()
    }
    @objc private func moreMenuEffects() {
        tapFeedback(view.viewWithTag(9073) as? UIButton)
        dismissMoreMenu()
        // Let the menu card fade before the effects strip slides up.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.presentEffectsPanel()
        }
    }
    /// [2026-10-16 wave13-B efeitos] Native effects strip (fundo + luz). The
    /// self-view PiP stays visible above it = live preview of the choice.
    private func presentEffectsPanel() {
        if view.subviews.contains(where: { $0 is CallFxPanel }) { return }
        if let t = session.localVideoTrack { CallFx.shared.attach(t) }
        CallFxPanel.present(in: self, cameraOn: { [weak self] in
            guard let self = self else { return false }
            return self.session.camEnabled && self.session.localVideoTrack != nil
        })
        if let pip = localPipContainer, !pip.isHidden { view.bringSubviewToFront(pip) }
    }
    @objc private func moreMenuHold() {
        tapFeedback(view.viewWithTag(9074) as? UIButton)
        dismissMoreMenu()
        session.onHold = !session.onHold
        applyHold(session.onHold)
    }
    @objc private func moreMenuAddMember() {
        tapFeedback(view.viewWithTag(9075) as? UIButton)
        dismissMoreMenu()
        handleAddMember()
    }
    /// [2026-10-11 full-hd] "Economizar dados" (same UserDefaults key as the
    /// Settings switch). ON: capture ≤720p now + MEDIUM receive layer; the
    /// 1.0 Mbps send envelope is exact from the next camera publish (LK 2.0.18
    /// has no public API to re-cap a live sender). OFF: climbs back to Full HD.
    @objc private func moreMenuToggleDataSaver() {
        tapFeedback(view.viewWithTag(9076) as? UIButton)
        dismissMoreMenu()
        let next = !CallVideoQuality.isDataSaver
        CallVideoQuality.isDataSaver = next
        nativeCallDiag("video_data_saver", callId, "on=\(next ? 1 : 0) cur=\(CallVideoQuality.current.rawValue) env=\(CallVideoQuality.layersLabel()) net=\(CallNetworkSnapshot.shared.label)")
        if let r = room { Self.applyReceivePreference(room: r) }
        adaptiveVideo?.dataSaverChanged()
    }

    /// Nested emoji picker for the More → Reactions path. Each emoji calls the
    /// existing sendReaction(_:) which bursts locally + publishes over the LK
    /// data channel + fires the parity WS event.
    private func presentReactionPicker() {
        let sheet = UIAlertController(title: CallStrings.s("sendReaction"), message: nil, preferredStyle: .actionSheet)
        for emoji in ["❤️", "😂", "👍", "🎉", "😮", "🖐️"] {
            sheet.addAction(UIAlertAction(title: emoji, style: .default) { [weak self] _ in
                self?.sendReaction(emoji)
            })
        }
        sheet.addAction(UIAlertAction(title: CallStrings.s("cancel"), style: .cancel, handler: nil))
        if let pop = sheet.popoverPresentationController, let anchor = view.viewWithTag(9007) {
            pop.sourceView = anchor
            pop.sourceRect = anchor.bounds
        }
        present(sheet, animated: true, completion: nil)
    }

    // MARK: - [2026-10-14 group-ui] 1:1 → grid (3+ people)

    private var myBareEmail: String {
        let e = UserDefaults(suiteName: "group.com.onemundo.mail")?.string(forKey: "user_email") ?? ""
        return GroupCallViewController.bareEmail(e)
    }

    private var peerBareEmail: String {
        return GroupCallViewController.bareEmail(callerEmail)
    }

    private func gridName(identity: String, lkName: String?) -> String {
        let bare = GroupCallViewController.bareEmail(identity)
        if bare == peerBareEmail, !callerName.isEmpty { return callerName }
        if let n = gridNames[bare], !n.isEmpty { return n }
        if let n = lkName, !n.isEmpty, n != identity, !n.contains("#") { return n }
        let local = bare.split(separator: "@").first.map(String.init) ?? bare
        return local.isEmpty ? identity : local
    }

    /// Coalesced rebuild (MAIN THREAD): many LiveKit events land together.
    private func requestGridRebuild() {
        guard !gridRebuildPending else { return }
        gridRebuildPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.gridRebuildPending = false
            self.rebuildGrid()
        }
    }

    /// Rebuild the grid model from the Room (remote people, one tile per email —
    /// a callee's 2nd device ringing must not look like a 3rd person), screen
    /// shares, and invitees that did not join yet; switch grid mode on/off.
    private func rebuildGrid() {
        guard !didHangup, let r = room else { return }
        let me = myBareEmail
        var byIdentity: [String: RemoteParticipant] = [:]
        for rp in r.remoteParticipants.values {
            guard let identity = rp.identity?.stringValue, !identity.isEmpty else { continue }
            byIdentity[identity] = rp
            if !gridOrder.contains(identity) { gridOrder.append(identity) }
        }
        gridOrder = gridOrder.filter { byIdentity[$0] != nil }

        // One representative identity per email: the one with media, else the first.
        var repForBare: [String: String] = [:]
        var bareOrder: [String] = []
        for identity in gridOrder {
            guard let rp = byIdentity[identity] else { continue }
            let bare = GroupCallViewController.bareEmail(identity)
            if bare.isEmpty || bare == me { continue }
            if let cur = repForBare[bare] {
                let curHasMedia = !(byIdentity[cur]?.trackPublications.isEmpty ?? true)
                if !curHasMedia && !rp.trackPublications.isEmpty { repForBare[bare] = identity }
            } else {
                repForBare[bare] = identity
                bareOrder.append(bare)
            }
        }

        var screens: [GroupParticipant] = []
        var people: [GroupParticipant] = []
        var ringingTiles: [GroupParticipant] = []
        var inCall = 0
        for bare in bareOrder {
            guard let identity = repForBare[bare], let rp = byIdentity[identity] else { continue }
            let name = gridName(identity: identity, lkName: rp.name)
            let ringing = gridRinging[bare] != nil && rp.trackPublications.isEmpty
            let camPub = rp.videoTracks.first(where: { $0.source != .screenShareVideo })
            let camTrack: VideoTrack? = (camPub?.isMuted == false) ? (camPub?.track as? VideoTrack) : nil
            let tile = GroupParticipant(
                id: "remote:" + bare,
                identity: identity,
                name: name,
                videoTrack: ringing ? nil : camTrack,
                audioMuted: rp.audioTracks.first?.isMuted ?? false,
                isLocal: false,
                isSpeaking: gridSpeaking.contains(identity),
                handRaised: false,
                connectionQuality: gridQuality[identity] ?? 3,
                isRinging: ringing
            )
            if ringing { ringingTiles.append(tile) } else { people.append(tile); inCall += 1 }
            if let sp = rp.videoTracks.first(where: { $0.source == .screenShareVideo }),
               !sp.isMuted, let st = sp.track as? VideoTrack {
                let sid = GroupParticipant.screenPrefix + identity
                screens.append(GroupParticipant(
                    id: sid,
                    identity: sid,
                    name: GroupCallStrings.s("gx.screenOf", ["name": name]),
                    videoTrack: st,
                    isScreen: true
                ))
            }
        }
        // Rung via "Adicionar" but not in the Room yet.
        for (bare, name) in gridRinging.sorted(by: { $0.key < $1.key }) where repForBare[bare] == nil && bare != me {
            ringingTiles.append(GroupParticipant(id: "ring:" + bare, identity: bare, name: name, isRinging: true))
        }

        let tiles = screens + people + ringingTiles
        gridPeopleCount = inCall + 1
        // Grid only once the call is up (ringing / 1:1 screens unchanged) and
        // there are 2+ other people (in the call or being rung).
        let wantGrid = callConnectedAt != nil && (people.count + ringingTiles.count) >= 2
        if let pin = gridSession.pinnedIdentity, !tiles.contains(where: { $0.identity == pin }) {
            gridSession.pinnedIdentity = nil
        }
        if let fid = gridSession.fullscreenId, !tiles.contains(where: { $0.id == fid }) {
            gridSession.fullscreenId = nil
        }
        // [2026-10-15 screen-share whatsapp-level] A NEW screen share opens
        // full screen automatically (X = minimise back to its tile).
        let previousIds = Set(gridSession.participants.map { $0.id })
        let newScreen = screens.first(where: { !previousIds.contains($0.id) })
        gridSession.participants = tiles
        if wantGrid != gridActive { setGridActive(wantGrid) }
        if wantGrid, let ns = newScreen, gridSession.fullscreenId == nil, presentedViewController == nil {
            gridSession.fullscreenId = ns.id
        }
        updateGridHeader()
    }

    private func setGridActive(_ on: Bool) {
        gridActive = on
        nativeCallDiag("call_grid_mode", callId, "on=\(on ? 1 : 0) tiles=\(gridSession.participants.count)")
        if on {
            // Controls always visible in grid mode (no video auto-hide / scrim).
            exitVideoControlsMode()
            if videoSwapped { restoreVideoSwap() }
            let host: UIHostingController<GroupGridView>
            if let h = gridHost {
                host = h
            } else {
                let root = GroupGridView(session: gridSession, waitingSubtitle: "", onTogglePin: { [weak self] identity in
                    self?.toggleGridPin(identity)
                })
                host = UIHostingController(rootView: root)
                host.view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x0B/255.0, blue: 0x0D/255.0, alpha: 1.0)
                host.view.translatesAutoresizingMaskIntoConstraints = false
                gridHost = host
            }
            if host.view.superview == nil {
                addChild(host)
                view.addSubview(host.view)
                NSLayoutConstraint.activate([
                    host.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 76),
                    host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
                    host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
                    host.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -132),
                ])
                host.didMove(toParent: self)
            }
            let header = ensureGridHeader()
            host.view.alpha = 0
            header.alpha = 0
            frontGridChrome()
            UIView.animate(withDuration: 0.25) {
                host.view.alpha = 1
                header.alpha = 1
                // The 1:1 avatar / name / status block lives under the grid.
                for tag in [9000, 9001, 9040, 9045, 9020] {
                    if let v = self.view.viewWithTag(tag), v.superview === self.view { v.alpha = 0 }
                }
                self.avatarContainerView()?.alpha = 0
            }
            gridHeaderTimer?.invalidate()
            gridHeaderTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                self?.updateGridHeader()
            }
        } else {
            gridHeaderTimer?.invalidate()
            gridHeaderTimer = nil
            gridSession.pinnedIdentity = nil
            gridSession.fullscreenId = nil
            if let host = gridHost {
                UIView.animate(withDuration: 0.2, animations: {
                    host.view.alpha = 0
                    self.gridHeaderLabel?.alpha = 0
                }, completion: { _ in
                    guard !self.gridActive else { return }
                    host.willMove(toParent: nil)
                    host.view.removeFromSuperview()
                    host.removeFromParent()
                })
            }
            for tag in [9000, 9001, 9045] {
                if let v = view.viewWithTag(tag), v.superview === view { v.alpha = 1 }
            }
            if session.isGroup, let v = view.viewWithTag(9040) { v.alpha = 1 }
            avatarContainerView()?.alpha = 1
            // Back to 1:1: show the remaining person's live video (the 1:1 path
            // nils remoteVideoTrack whenever ANY participant leaves).
            var restore: VideoTrack? = nil
            if let r = room {
                let me = myBareEmail
                for rp in r.remoteParticipants.values {
                    let bare = GroupCallViewController.bareEmail(rp.identity?.stringValue ?? "")
                    if bare.isEmpty || bare == me { continue }
                    if let pub = rp.videoTracks.first(where: { $0.source == .screenShareVideo && !$0.isMuted && $0.track != nil })
                        ?? rp.videoTracks.first(where: { !$0.isMuted && $0.track != nil }),
                       let vt = pub.track as? VideoTrack {
                        restore = vt
                        break
                    }
                }
            }
            session.remoteVideoTrack = restore // sink → applyRemoteVideoTrack (avatar if nil)
        }
    }

    /// Grid above the 1:1 visuals, call chrome (controls, top bar, self-view,
    /// "Conexão fraca", sharing chip, notices) above the grid.
    private func frontGridChrome() {
        guard gridActive, let gv = gridHost?.view, gv.superview === view else { return }
        view.bringSubviewToFront(gv)
        if let header = gridHeaderLabel { view.bringSubviewToFront(header) }
        // Tag 9008 is ALSO the top-bar message button → match the bar stack itself.
        if let bar = view.subviews.first(where: { $0 is UIStackView && $0.tag == 9008 }) {
            view.bringSubviewToFront(bar)
        }
        if let bars = view.viewWithTag(9010), let topBar = bars.superview, topBar.superview === view {
            view.bringSubviewToFront(topBar)
        }
        if let chip = view.subviews.first(where: { $0.tag == 9012 }) { view.bringSubviewToFront(chip) }
        if let pill = weakPill, pill.superview === view { view.bringSubviewToFront(pill) }
        if let pip = localPipContainer { view.bringSubviewToFront(pip) }
        if let t = gridToastView { view.bringSubviewToFront(t) }
    }

    /// applyRemoteVideoTrack fronts the remote video (1:1 path) — keep it, and
    /// the avatar labels, UNDER the grid while grid mode is on.
    private func keepGridOnTop() {
        guard gridActive, let gv = gridHost?.view, gv.superview === view else { return }
        if let remote = remoteVideoView, remote.superview === view { view.insertSubview(remote, belowSubview: gv) }
        for tag in [9000, 9001, 9040, 9045] {
            if let v = view.viewWithTag(tag), v.superview === view {
                view.insertSubview(v, belowSubview: gv)
                v.alpha = 0
            }
        }
        avatarContainerView()?.alpha = 0
    }

    private func ensureGridHeader() -> UILabel {
        if let l = gridHeaderLabel { return l }
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.textColor = UIColor.white.withAlphaComponent(0.8)
        l.font = .monospacedDigitSystemFont(ofSize: 14, weight: .medium)
        l.textAlignment = .center
        l.isUserInteractionEnabled = false
        view.addSubview(l)
        NSLayoutConstraint.activate([
            l.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 50),
            l.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            l.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            l.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
        ])
        gridHeaderLabel = l
        return l
    }

    /// "3 participantes · 04:12" over the grid (the 1:1 status label is hidden).
    private func updateGridHeader() {
        guard gridActive, let l = gridHeaderLabel else { return }
        var text = GroupCallStrings.participants(gridPeopleCount)
        if let t0 = callConnectedAt {
            let secs = max(0, Int(Date().timeIntervalSince(t0)))
            let h = secs / 3600, m = (secs % 3600) / 60, sec = secs % 60
            let dur = h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%02d:%02d", m, sec)
            text += " · " + dur
        }
        if session.connectionQuality <= 1 { text = CallStrings.s("weakConnection") }
        l.text = text
    }

    private func toggleGridPin(_ identity: String) {
        guard gridSession.participants.count >= 2 || gridSession.pinnedIdentity != nil else { return }
        gridSession.pinnedIdentity = (gridSession.pinnedIdentity == identity) ? nil : identity
    }

    /// Picker rang these people INTO the call → "Tocando…" tiles right away.
    private func gridAddInvites(_ rung: [String: String]) {
        let me = myBareEmail
        var added = false
        for (email, name) in rung {
            let bare = GroupCallViewController.bareEmail(email)
            guard !bare.isEmpty, bare != me else { continue }
            gridNames[bare] = name
            // Already in the call with media → nothing to ring.
            let inCallWithMedia = room?.remoteParticipants.values.contains(where: {
                GroupCallViewController.bareEmail($0.identity?.stringValue ?? "") == bare && !$0.trackPublications.isEmpty
            }) ?? false
            if inCallWithMedia { continue }
            gridRinging[bare] = name
            added = true
            scheduleGridRingingExpiry(bare)
        }
        if added {
            installGridDeclineObserver()
            requestGridRebuild()
        }
    }

    private func scheduleGridRingingExpiry(_ bare: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard let self = self, !self.didHangup else { return }
            if self.gridRinging.removeValue(forKey: bare) != nil { self.requestGridRebuild() }
        }
    }

    /// WS call_declined from an invitee (declined_by_email) → drop the tile.
    /// A refusal of the 1:1 itself never reaches here with a live grid (the
    /// call was already connected).
    private func installGridDeclineObserver() {
        guard gridDeclineObserver == nil else { return }
        gridDeclineObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("CallKitCallDeclinedRemote"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self, (note.userInfo?["callId"] as? String) == self.callId else { return }
            let who = GroupCallViewController.bareEmail((note.userInfo?["declinedByEmail"] as? String) ?? "")
            guard !who.isEmpty, self.gridRinging.removeValue(forKey: who) != nil else { return }
            nativeCallDiag("call_grid_invite_declined", self.callId, "by=\(who)")
            self.requestGridRebuild()
        }
    }

    /// First media from `identity` (MAIN THREAD): stop "Tocando…" and, for
    /// someone other than the 1:1 peer, say "Fulano entrou".
    private func gridNoteMedia(identity: String, lkName: String?) {
        guard !identity.isEmpty, identity != "?" else { return }
        let bare = GroupCallViewController.bareEmail(identity)
        if bare.isEmpty || bare == myBareEmail { return }
        gridRinging.removeValue(forKey: bare)
        if !gridAnnounced.contains(identity) {
            gridAnnounced.insert(identity)
            if bare != peerBareEmail && callConnectedAt != nil {
                showGridToast(GroupCallStrings.s("gx.joined", ["name": gridName(identity: identity, lkName: lkName)]))
            }
        }
        requestGridRebuild()
    }

    /// Discreet top notice ("Fulano entrou / saiu"), auto-hides.
    private func showGridToast(_ text: String) {
        gridToastWork?.cancel()
        let container: UIView
        let label: UILabel
        if let c = gridToastView, let l = c.subviews.first as? UILabel {
            container = c
            label = l
        } else {
            let c = UIView()
            c.translatesAutoresizingMaskIntoConstraints = false
            c.backgroundColor = UIColor.black.withAlphaComponent(0.72)
            c.layer.cornerRadius = 17
            c.layer.borderWidth = 0.5
            c.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
            c.isUserInteractionEnabled = false
            let l = UILabel()
            l.translatesAutoresizingMaskIntoConstraints = false
            l.textColor = .white
            l.font = .systemFont(ofSize: 14, weight: .medium)
            l.numberOfLines = 1
            c.addSubview(l)
            view.addSubview(c)
            NSLayoutConstraint.activate([
                l.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 14),
                l.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -14),
                l.topAnchor.constraint(equalTo: c.topAnchor, constant: 8),
                l.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -8),
                c.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                c.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 72),
                c.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            ])
            c.alpha = 0
            gridToastView = c
            container = c
            label = l
        }
        label.text = text
        view.bringSubviewToFront(container)
        UIView.animate(withDuration: 0.2) { container.alpha = 1 }
        let work = DispatchWorkItem { [weak container] in
            UIView.animate(withDuration: 0.25) { container?.alpha = 0 }
        }
        gridToastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6, execute: work)
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

    // MARK: - Video quality diag + network step-down (2026-10-06)
    //
    // Measurable quality: two beacons per video call (t+8s, t+45s) land in
    // voip_diag.log as `native_ios_video_quality` with the REAL negotiated
    // numbers — encoded res/fps/target bitrate/limitation reason/encoder,
    // codec, received res/fps/drops, chosen profile, network, bars. Read with
    //   grep video_quality /var/www/mail/data/voip_diag.log | tail
    // Step-down: cellular + 2 consecutive poor/lost readings on OUR link →
    // capture drops to 540p IN PLACE (CameraCapturer.set(options:) restarts
    // the capturer only — same track, no unpublish/republish, the remote side
    // keeps rendering). One-way per call; WebRTC's balanced degradation
    // handles the fine-grained ladder below that.

    private var videoQualityDiagWork: [DispatchWorkItem] = []
    /// [2026-10-11 full-hd] Per-call capture controller (bandwidth / thermal /
    /// data saver). Started with the first video beacon, stopped on teardown.
    private var adaptiveVideo: AdaptiveVideoController?

    private func scheduleVideoQualityDiag() {
        guard videoQualityDiagWork.isEmpty, hasVideo || session.camEnabled else { return }
        if adaptiveVideo == nil, let r = room {
            let c = AdaptiveVideoController(room: r, callId: callId, canApply: { [weak self] in
                guard let self = self else { return false }
                // [2026-10-18 call-resilience] never restart a camera we auto-paused.
                return !self.didHangup && !(self.videoAutoPause?.paused ?? false)
            })
            c.start()
            adaptiveVideo = c
        }
        // [video-fullhd 2026-10-22] + t20 (BWE já subiu: no t8 quase sempre só a camada q 270p está no ar,
        // e as ligações de teste acabam antes do t45 → zero dado pós-rampa em 7 dias) e t120 (regime).
        for (delay, tag) in [(8.0, "t8"), (20.0, "t20"), (45.0, "t45"), (120.0, "t120")] {
            let w = DispatchWorkItem { [weak self] in self?.reportVideoQuality(tag: tag) }
            videoQualityDiagWork.append(w)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
        }
    }

    private func cancelVideoQualityDiag() {
        videoQualityDiagWork.forEach { $0.cancel() }
        videoQualityDiagWork.removeAll()
    }

    private func localCameraTrack() -> LocalVideoTrack? {
        guard let r = room else { return nil }
        let pub = r.localParticipant.videoTracks.first { $0.source == .camera }
        return pub?.track as? LocalVideoTrack
    }

    private func reportVideoQuality(tag: String) {
        guard !didHangup, let r = room else { return }
        var parts: [String] = [
            "tag=\(tag)",
            "profile=\(CallVideoQuality.current.rawValue)",
            "net=\(CallNetworkSnapshot.shared.label)",
            "bars=\(session.connectionQuality)",
            "saver=\(CallVideoQuality.isDataSaver ? 1 : 0)",
            "thermal=\(CallVideoQuality.thermalLabel)",
            "max=\(CallVideoQuality.ceiling().0.rawValue)/\(CallVideoQuality.ceiling().1)",
            "layers=\(CallVideoQuality.layersLabel())",
        ]
        if let t = localCameraTrack() {
            if let d = t.dimensions { parts.append("cap=\(d.width)x\(d.height)") }
            if let s = t.statistics {
                if let o = s.outboundRtpStream.first(where: { ($0.frameWidth ?? 0) > 0 }) ?? s.outboundRtpStream.first {
                    parts.append("out=\(o.frameWidth ?? 0)x\(o.frameHeight ?? 0)@\(Int(o.framesPerSecond ?? 0))")
                    parts.append("tgt=\(Int((o.targetBitrate ?? 0) / 1000))k")
                    parts.append("lim=\(o.qualityLimitationReason?.rawValue ?? "?")")
                    parts.append("enc=\(o.encoderImplementation ?? "?")")
                    parts.append("pli=\(o.pliCount ?? 0) nack=\(o.nackCount ?? 0)")
                }
                if let c = s.codec.first(where: { ($0.mimeType ?? "").hasPrefix("video") }) ?? s.codec.first {
                    parts.append("codec=\(c.mimeType ?? "?")")
                }
                // [2026-10-11 full-hd] Every simulcast layer actually encoded
                // (rid q/h/f → low/mid/high; dynacast pauses unwatched ones).
                let layers = s.outboundRtpStream.map { o in
                    "\(o.rid ?? "-"):\(o.frameWidth ?? 0)x\(o.frameHeight ?? 0)@\(Int(o.framesPerSecond ?? 0))/\(Int((o.targetBitrate ?? 0) / 1000))k"
                }
                if !layers.isEmpty { parts.append("out_layers=\(layers.joined(separator: ","))") }
                // Safety net: camera live + unmuted at t+8s but NOT ONE frame
                // encoded on any layer while simulcast is on → this device's
                // encoder rejected the multi-encoding H.264 setup. Single
                // encoding for the next 7 days (still Full HD) + diag.
                let encoded = s.outboundRtpStream.reduce(UInt(0)) { $0 + ($1.framesEncoded ?? 0) }
                if tag == "t8", CallVideoQuality.simulcastEnabled, !t.isMuted,
                   !s.outboundRtpStream.isEmpty, encoded == 0 {
                    CallVideoQuality.disableSimulcastTemporarily()
                    parts.append("simulcast_autodisabled=1")
                }
            } else {
                parts.append("out=nostats")
            }
        } else {
            parts.append("cap=none")
        }
        if let rp = r.remoteParticipants.values.first,
           let pub = rp.videoTracks.first(where: { $0.source == .camera }) {
            if let d = pub.dimensions { parts.append("rx_pub=\(d.width)x\(d.height)") }
            parts.append("rx_mime=\(pub.mimeType)")
            if let t = pub.track as? RemoteVideoTrack {
                if let d = t.dimensions { parts.append("rx_dim=\(d.width)x\(d.height)") }
                if let s = t.statistics, let i = s.inboundRtpStream.first {
                    parts.append("rx=\(i.frameWidth ?? 0)x\(i.frameHeight ?? 0)@\(Int(i.framesPerSecond ?? 0)) drop=\(i.framesDropped ?? 0) rx_pli=\(i.pliCount ?? 0) rx_nack=\(i.nackCount ?? 0)")
                }
            }
            parts.append("rx_bars=\(rp.connectionQuality)")
        }
        let detail = parts.joined(separator: " ")
        print("[CallVC] video_quality \(detail)")
        nativeCallDiag("video_quality", callId, detail)
    }

    // MARK: - [2026-10-11 full-hd] "Conexão fraca" pill (Android parity:
    // CallActivity.WeakConnectionPill). POOR/LOST → shown after 3 s, hidden
    // 2 s after recovery; local wins over the peer; hidden while on hold or
    // reconnecting (the status line already says it).

    fileprivate func setWeakConnection(local: Bool, isWeak: Bool) {
        let cur = local ? localWeak : peerWeak
        let pending = local ? localWeakWork : peerWeakWork
        if cur == isWeak {
            pending?.cancel()
            if local { localWeakWork = nil } else { peerWeakWork = nil }
            return
        }
        if let p = pending, !p.isCancelled { return } // already heading there
        let w = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if local { self.localWeak = isWeak; self.localWeakWork = nil } else { self.peerWeak = isWeak; self.peerWeakWork = nil }
            nativeCallDiag("call_weak_connection", self.callId, "side=\(local ? "local" : "peer") weak=\(isWeak ? 1 : 0) profile=\(CallVideoQuality.current.rawValue)")
            self.updateWeakConnectionPill()
        }
        if local { localWeakWork = w } else { peerWeakWork = w }
        DispatchQueue.main.asyncAfter(deadline: .now() + (isWeak ? 3.0 : 2.0), execute: w)
    }

    private func updateWeakConnectionPill() {
        let reconnecting = session.status.hasPrefix("Reconectando")
        let text: String?
        if didHangup || session.onHold || peerOnHold || reconnecting {
            text = nil
        } else if videoAutoPause?.paused == true {
            text = CallResilience.text("videoPaused", lang: GroupCallStrings.lang) // [2026-10-18 call-resilience]
        } else if localWeak {
            text = CallStrings.s("weakConnection")
        } else if peerWeak {
            let who = callerName.isEmpty ? (callerEmail.components(separatedBy: "@").first ?? callerEmail) : callerName
            text = CallStrings.s("peerWeakConnection", ["name": who])
        } else {
            text = nil
        }
        let pill: UIView
        if let p = weakPill {
            pill = p
        } else {
            guard text != nil else { return }
            let p = UIView()
            p.translatesAutoresizingMaskIntoConstraints = false
            p.backgroundColor = UIColor.black.withAlphaComponent(0.55)
            p.layer.cornerRadius = 15
            p.isUserInteractionEnabled = false
            p.alpha = 0
            let icon = UIImageView(image: UIImage(systemName: "wifi.exclamationmark"))
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.tintColor = .white // [2026-10-16 P&B] era amarelo
            icon.contentMode = .scaleAspectFit
            let lbl = UILabel()
            lbl.translatesAutoresizingMaskIntoConstraints = false
            lbl.textColor = .white
            lbl.font = .systemFont(ofSize: 13, weight: .medium)
            lbl.tag = 9091
            p.addSubview(icon)
            p.addSubview(lbl)
            view.addSubview(p)
            NSLayoutConstraint.activate([
                p.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 60),
                p.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                p.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32),
                icon.leadingAnchor.constraint(equalTo: p.leadingAnchor, constant: 12),
                icon.centerYAnchor.constraint(equalTo: p.centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: 14),
                icon.heightAnchor.constraint(equalToConstant: 14),
                lbl.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
                lbl.trailingAnchor.constraint(equalTo: p.trailingAnchor, constant: -12),
                lbl.topAnchor.constraint(equalTo: p.topAnchor, constant: 6),
                lbl.bottomAnchor.constraint(equalTo: p.bottomAnchor, constant: -6),
            ])
            weakPill = p
            pill = p
        }
        view.bringSubviewToFront(pill)
        if let t = text { (pill.viewWithTag(9091) as? UILabel)?.text = t }
        UIView.animate(withDuration: 0.25) { pill.alpha = (text == nil) ? 0 : 1 }
    }

    /// [2026-10-11 full-hd] Local quality → adaptive controller (the old
    /// one-way "cellular + 2× poor → 540p" step-down is folded into it).
    private func noteLocalConnectionQuality(_ score: Int) {
        adaptiveVideo?.noteLocalQuality(score)
        videoAutoPause?.noteLocalQuality(score) // [2026-10-18 call-resilience]
    }

    private func cleanupCallTimers() {
        // [video-quality 2026-10-06] Drop pending quality beacons on teardown.
        cancelVideoQualityDiag()
        adaptiveVideo?.stop()
        adaptiveVideo = nil
        localWeakWork?.cancel()
        peerWeakWork?.cancel()
        dotsTimer?.invalidate()
        dotsTimer = nil
        durationTimer?.invalidate()
        durationTimer = nil
    }

    // MARK: - Video rendering (#1358, 2026-05-25)
    //
    // FULL video-call parity on the native iOS call screen. Receiving a video
    // call now renders the peer's camera full-bleed + a draggable local PiP
    // tile + a camera-flip control + auto-hiding controls in video mode —
    // matching the JS /call.js outgoing screen.
    //
    // Pure UIKit. Uses LiveKit's `VideoView` (a UIView subclass) — never
    // SwiftUI. The remote view sits ABOVE the gradient/avatar layers but BELOW
    // the controls + top bar; the local PiP floats on top.

    /// z-order helper: the remote video view must sit above the CAGradientLayer
    /// (inserted at index 0 in viewDidLoad) and the avatar/pulse UIViews, but
    /// below the controls/top-bar. We insert it just above the pulseContainer
    /// (tag 9020) so it covers the avatar block when active, then send the
    /// controls + PiP back to front as needed.
    private func setupVideoViews() {
        // Remote full-bleed renderer — hidden until a remote video track lands.
        let remote = VideoView()
        remote.translatesAutoresizingMaskIntoConstraints = false
        remote.layoutMode = .fill          // aspect-fill, like JS objectFit:"cover"
        remote.mirrorMode = .off           // remote is NEVER mirrored
        remote.backgroundColor = .clear
        remote.isHidden = true
        remote.isUserInteractionEnabled = false
        // Insert ABOVE the gradient + avatar (avatarView/pulse were addSubview'd
        // after the gradient layer) but BELOW everything we add afterwards.
        // Place it just above the pulse container so the avatar is covered when
        // video is live; the controls + top bar were added before this point in
        // viewDidLoad, so we must push them back to front.
        if let pulse = view.viewWithTag(9020) {
            view.insertSubview(remote, aboveSubview: pulse)
        } else {
            view.insertSubview(remote, at: 1)
        }
        NSLayoutConstraint.activate([
            remote.topAnchor.constraint(equalTo: view.topAnchor),
            remote.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            remote.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            remote.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        self.remoteVideoView = remote

        // Local-camera PiP tile — rounded card holding a fill VideoView + a tiny
        // flip button. Draggable (FaceTime-style edge snap). Hidden until the
        // local camera publishes AND camEnabled is true.
        let pip = UIView()
        pip.translatesAutoresizingMaskIntoConstraints = false
        pip.backgroundColor = UIColor(red: 0x11/255.0, green: 0x11/255.0, blue: 0x11/255.0, alpha: 1.0) // [2026-10-16 P&B]
        pip.layer.cornerRadius = 18
        pip.clipsToBounds = true
        pip.layer.borderWidth = 1.5
        pip.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        // Shadow needs to be on a non-clipped layer; clipsToBounds clips it, so
        // we mirror the shadow on the layer and accept the rounded clip — iOS
        // still draws the shadow outside the bounds because shadow is composited
        // separately from content clip on CALayer. Keep masksToBounds false at
        // the layer level while clipsToBounds rounds the content via cornerRadius
        // + a content sublayer mask. Simpler: wrap shadow on the layer.
        pip.layer.shadowColor = UIColor.black.cgColor
        pip.layer.shadowOpacity = 0.45
        pip.layer.shadowRadius = 8
        pip.layer.shadowOffset = CGSize(width: 0, height: 3)
        pip.layer.masksToBounds = false
        pip.isHidden = true
        pip.alpha = 0

        // PiP size + default position (top-right, below the top bar). The
        // container + its children use frame-based layout (autoresizing masks)
        // so the pan gesture can move the tile freely without fighting Auto
        // Layout. The VideoView fills the container; the flip button sits
        // bottom-right and stays pinned via a flexible-margin autoresizing mask.
        let pipW: CGFloat = 110
        let pipH: CGFloat = 156
        pip.translatesAutoresizingMaskIntoConstraints = true
        let bounds = UIScreen.main.bounds
        let topInset = view.safeAreaInsets.top
        let initialX = bounds.width - pipW - 14
        let initialY = max(topInset, 20) + 56
        pip.frame = CGRect(x: initialX, y: initialY, width: pipW, height: pipH)

        let local = VideoView()
        local.translatesAutoresizingMaskIntoConstraints = true
        local.frame = CGRect(x: 0, y: 0, width: pipW, height: pipH)
        local.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        local.layoutMode = .fill
        local.mirrorMode = .auto           // front camera mirrors automatically
        local.backgroundColor = .clear
        local.isUserInteractionEnabled = false
        pip.addSubview(local)

        // Tiny flip button on the PiP tile (bottom-right) — convenient swap.
        let pipFlip = UIButton(type: .system)
        pipFlip.translatesAutoresizingMaskIntoConstraints = true
        pipFlip.frame = CGRect(x: pipW - 26 - 6, y: pipH - 26 - 6, width: 26, height: 26)
        pipFlip.autoresizingMask = [.flexibleLeftMargin, .flexibleTopMargin]
        pipFlip.tintColor = .white
        let fcfg = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        pipFlip.setImage(UIImage(systemName: "arrow.triangle.2.circlepath", withConfiguration: fcfg), for: .normal)
        pipFlip.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        pipFlip.layer.cornerRadius = 13
        pipFlip.clipsToBounds = true
        pipFlip.addTarget(self, action: #selector(uikitOnFlipCamera), for: .touchUpInside)
        pip.addSubview(pipFlip)

        view.addSubview(pip)
        self.localVideoView = local
        self.localPipContainer = pip

        // Drag gesture (FaceTime edge-snap).
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePipPan(_:)))
        pip.addGestureRecognizer(pan)
        // [2026-10-14 self-view] Tap = swap main/mini (WhatsApp).
        let pipTap = UITapGestureRecognizer(target: self, action: #selector(handleLocalPipTap))
        pip.addGestureRecognizer(pipTap)
        pip.isUserInteractionEnabled = true

        // Make sure controls + top bar render ABOVE the remote video. The
        // control bar (9008), name/status labels (9000/9001), participant
        // count (9040) and the top bar were all added before `remote`; bring
        // them forward. [UI rewrite 2026-05-25] The control buttons now live
        // inside the controlBar stack (9008), so we front the bar — NOT the
        // individual button tags (those are nested and fronting them is a
        // no-op).
        for tag in [9000, 9001, 9008, 9040] {
            if let v = view.viewWithTag(tag) { view.bringSubviewToFront(v) }
        }
        // Top bar (minimize chevron + connection bars + lock) — find via the
        // barsContainer tag 9010's superview, which is the topBar UIView.
        if let bars = view.viewWithTag(9010), let topBar = bars.superview {
            view.bringSubviewToFront(topBar)
        }
        // PiP always on top.
        view.bringSubviewToFront(pip)

        // ── Combine sinks ──────────────────────────────────────────────────
        // Remote track: render full-bleed + hide avatar UI; nil → detach + show
        // avatar again.
        remoteVideoObserver = session.$remoteVideoTrack
            .receive(on: DispatchQueue.main)
            .sink { [weak self] track in
                self?.applyRemoteVideoTrack(track)
            }

        // Local track: render in the PiP tile (visible only while camEnabled).
        localVideoObserver = session.$localVideoTrack
            .receive(on: DispatchQueue.main)
            .sink { [weak self] track in
                self?.applyLocalVideoTrack(track)
            }

        // Floating emoji reactions (local send + incoming data-channel). The
        // dead SwiftUI CallView used to render session.floatingReactions; do it
        // in UIKit with a rise-and-fade animation. We diff by id so each
        // reaction animates exactly once.
        reactionsObserver = session.$floatingReactions
            .receive(on: DispatchQueue.main)
            .sink { [weak self] reactions in
                guard let self = self else { return }
                for r in reactions where !self.animatedReactionIds.contains(r.id) {
                    self.animatedReactionIds.insert(r.id)
                    self.spawnFloatingReaction(r.emoji, xOffset: r.xOffset)
                }
            }
    }

    /// Animate a single floating emoji label: rise ~220pt while fading out.
    private func spawnFloatingReaction(_ emoji: String, xOffset: CGFloat) {
        let label = UILabel()
        label.text = emoji
        label.font = .systemFont(ofSize: 44)
        label.textAlignment = .center
        label.sizeToFit()
        let startX = view.bounds.width / 2 + xOffset - label.bounds.width / 2
        let startY = view.bounds.height - view.safeAreaInsets.bottom - 200
        label.frame.origin = CGPoint(x: startX, y: startY)
        view.addSubview(label)
        view.bringSubviewToFront(label)
        UIView.animate(withDuration: 2.6, delay: 0, options: [.curveEaseOut], animations: {
            label.frame.origin.y -= 220
            label.alpha = 0
        }, completion: { _ in
            label.removeFromSuperview()
        })
    }

    /// Bind / unbind the remote camera. Drives the avatar↔video crossfade +
    /// the video-mode controls scrim + auto-hide timer.
    private func applyRemoteVideoTrack(_ track: VideoTrack?) {
        guard let remote = remoteVideoView else { return }
        if videoSwapped { restoreVideoSwap() }   // [2026-10-14 self-view]
        if let track = track {
            // [2026-10-14 screen-share viewer] Peer's SCREEN → aspect-FIT (the
            // whole screen legible, no crop; pinch zooms + drag pans), camera →
            // aspect-FILL. Reset any zoom when the source changes (screen ends
            // → back to the camera at 1×).
            let isScreen = (track.source == .screenShareVideo)
            let wantMode: VideoView.LayoutMode = isScreen ? .fit : .fill
            if remote.layoutMode != wantMode { remote.layoutMode = wantMode }
            if remote.track !== track { resetRemoteZoom() }
            remote.backgroundColor = isScreen ? .black : .clear
            remote.track = track
            remote.isHidden = false
            remoteVideoActive = true
            // [2026-05-25 #1358 video fix] The remote VideoView MUST sit above the
            // avatar/name/status/badge overlay (which were addSubview'd after the
            // gradient) but below the controls + top bar. setupVideoViews inserts
            // it aboveSubview: pulse, but the e2e badge (9045), name (9000),
            // status (9001) and participant count (9040) were added afterwards and
            // therefore float ABOVE the video — that's why "Criptografada" covered
            // the picture. Re-front the video over those overlay labels here, then
            // re-front ONLY the persistent call chrome (controls 9008 + top bar)
            // so the buttons stay tappable. The name/status/badge belong to the
            // avatar overlay and are faded out below.
            self.view.bringSubviewToFront(remote)
            if let controls = self.view.viewWithTag(9008) { self.view.bringSubviewToFront(controls) }
            if let bars = self.view.viewWithTag(9010), let topBar = bars.superview {
                self.view.bringSubviewToFront(topBar)
            }
            // PiP local tile always stays on top of everything.
            if let pip = self.localPipContainer { self.view.bringSubviewToFront(pip) }
            // Hide avatar + pulse rings + initial label + encryption badge +
            // participant count — video owns the screen. The "Criptografada" pill
            // is part of this overlay; it fades with the rest so it never covers
            // the picture, and comes back if the camera goes off.
            UIView.animate(withDuration: 0.3) {
                remote.alpha = 1
                if let av = self.avatarContainerView() { av.alpha = 0 }
                if let pulse = self.view.viewWithTag(9020) { pulse.alpha = 0 }
                if let badge = self.view.viewWithTag(9045) { badge.alpha = 0 }
                if let count = self.view.viewWithTag(9040) { count.alpha = 0 }
            }
            // Switch the controls to video mode (scrim + auto-hide + tap toggle).
            enterVideoControlsMode()
        } else {
            remote.track = nil
            remote.isHidden = true
            remoteVideoActive = false
            resetRemoteZoom()
            // Mid-call camera-off (it WAS a video call): show avatar over a dim
            // background instead of a black screen (P1 item 6).
            UIView.animate(withDuration: 0.3) {
                remote.alpha = 0
                if let av = self.avatarContainerView() { av.alpha = 1 }
                // Restore the encryption badge + participant count overlay now
                // that the avatar screen is showing again.
                if let badge = self.view.viewWithTag(9045) { badge.alpha = 1 }
                if self.session.isGroup, let count = self.view.viewWithTag(9040) { count.alpha = 1 }
                // Only un-hide pulse rings if the call hasn't connected yet;
                // once connected the statusObserver fades them out and we leave
                // them hidden. Re-show avatar regardless.
            }
            // Leave video controls mode → controls stay visible (no auto-hide).
            exitVideoControlsMode()
        }
        updateRemoteScreenShareUI(track) // [2026-10-15 screen-share viewer]
        keepGridOnTop() // [2026-10-14 group-ui] no-op outside grid mode
    }

    // MARK: - [2026-10-15 screen-share whatsapp-level] Viewer (1:1)
    //
    // Peer's screen arrives → it already owns the full screen (aspect-fit,
    // pinch/drag zoom) + "Fulano está compartilhando a tela" pill + double
    // tap = 2.5× at the tapped point / back to 1×; tapping the self-view tile
    // still swaps (= minimise the screen into the tile). Rotating the phone
    // to landscape shows the shared screen in landscape
    // (ScreenShareLandscapePresenter — the app is portrait-locked on iPhone).

    private var remoteScreenBanner: UIView?
    private var remoteDoubleTap: UITapGestureRecognizer?
    private var screenShareLandscape: ScreenShareLandscapePresenter?
    private var remoteScreenShown = false

    private func updateRemoteScreenShareUI(_ track: VideoTrack?) {
        let isScreen = (track?.source == .screenShareVideo) && !gridActive
        if isScreen, let t = track {
            if !remoteScreenShown {
                remoteScreenShown = true
                nativeCallDiag("screen_share_viewer_started", callId)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            showRemoteScreenBanner()
            installRemoteDoubleTap()
            if screenShareLandscape == nil {
                screenShareLandscape = ScreenShareLandscapePresenter(host: view)
            }
            screenShareLandscape?.attach(track: t)
        } else {
            if remoteScreenShown {
                remoteScreenShown = false
                nativeCallDiag("screen_share_viewer_ended", callId)
            }
            hideRemoteScreenBanner()
            screenShareLandscape?.detach()
        }
    }

    private func showRemoteScreenBanner() {
        let name = callerName.isEmpty ? callerEmail : callerName
        let text = CallStrings.s("ssPeerSharing", ["name": name])
        if let b = remoteScreenBanner {
            (b.viewWithTag(1) as? UILabel)?.text = text
            view.bringSubviewToFront(b)
            return
        }
        let pill = UIView()
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.62)
        pill.layer.cornerRadius = 15
        pill.isUserInteractionEnabled = false
        let icon = UIImageView(image: UIImage(systemName: "rectangle.on.rectangle",
                                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .white
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.tag = 1
        label.text = text
        label.textColor = .white
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        pill.addSubview(icon)
        pill.addSubview(label)
        view.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 56),
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.heightAnchor.constraint(equalToConstant: 30),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            pill.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
            icon.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 12),
            icon.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 15),
            icon.heightAnchor.constraint(equalToConstant: 15),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -12),
            label.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
        pill.alpha = 0
        remoteScreenBanner = pill
        UIView.animate(withDuration: 0.25) { pill.alpha = 1 }
        // Discreet: fades after 4 s (the controls tap brings nothing back —
        // same as WhatsApp's transient notice).
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak pill] in
            guard let self = self, let pill = pill, self.remoteScreenBanner === pill else { return }
            UIView.animate(withDuration: 0.4) { pill.alpha = 0 }
        }
    }

    private func hideRemoteScreenBanner() {
        guard let b = remoteScreenBanner else { return }
        remoteScreenBanner = nil
        UIView.animate(withDuration: 0.2, animations: { b.alpha = 0 }) { _ in b.removeFromSuperview() }
    }

    private func installRemoteDoubleTap() {
        guard remoteDoubleTap == nil, let remote = remoteVideoView else { return }
        remote.isUserInteractionEnabled = true
        let dt = UITapGestureRecognizer(target: self, action: #selector(handleRemoteDoubleTap(_:)))
        dt.numberOfTapsRequired = 2
        remote.addGestureRecognizer(dt)
        remoteDoubleTap = dt
        // Single tap (controls toggle) waits for the double tap to fail so a
        // double tap doesn't flash the controls.
        videoTapGesture?.require(toFail: dt)
    }

    @objc private func handleRemoteDoubleTap(_ gr: UITapGestureRecognizer) {
        guard let remote = remoteVideoView, !videoSwapped else { return }
        if remoteZoomScale > 1.01 {
            remoteZoomScale = 1.0
            remotePanOffset = .zero
            UIView.animate(withDuration: 0.25) { remote.transform = .identity }
            return
        }
        let scale: CGFloat = 2.5
        // Zoom toward the tapped point: offset = (center - p) * (scale - 1).
        let p = gr.location(in: view)
        let c = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        let proposed = CGPoint(x: (c.x - p.x) * (scale - 1), y: (c.y - p.y) * (scale - 1))
        remoteZoomScale = scale
        remotePanOffset = clampedRemotePan(proposed, scale: scale)
        UIView.animate(withDuration: 0.25) {
            remote.transform = self.remoteZoomTransform(scale: scale, offset: self.remotePanOffset)
        }
    }

    /// The avatar wrapper UIView. We don't tag it, so locate it via the tagged
    /// initial label (9031) / image (9030) superview.
    private func avatarContainerView() -> UIView? {
        if let iv = view.viewWithTag(9030) { return iv.superview }
        if let lbl = view.viewWithTag(9031) { return lbl.superview }
        return nil
    }

    /// [2026-10-14 self-view] Founder: "quando estou na câmera não consigo me
    /// ver". The caller's camera was only created on ANSWER (ring-leak gate,
    /// 2026-10-04), so a video call showed no self-view while ringing, and if
    /// that single publish threw there was none for the whole call. Capture
    /// locally now (no publish → the callee's subscribe-only preconnect still
    /// gets nothing before Accept); openOutgoingMicGate publishes this same
    /// track. Idempotent; main thread.
    private func startOutgoingCameraPreview() {
        guard hasVideo, isOutgoing, !outgoingMicGateOpen, !didHangup,
              session.camEnabled, session.localVideoTrack == nil,
              outgoingPreviewTrack == nil else { return }
        let track = LocalVideoTrack.createCameraTrack(
            options: Self.defaultCameraCaptureOptions(position: currentCameraPosition))
        outgoingPreviewTrack = track
        let cid = callId
        Task { [weak self] in
            do {
                try await track.start()
                await MainActor.run {
                    guard let self = self, self.outgoingPreviewTrack === track,
                          self.session.localVideoTrack == nil else { return }
                    self.session.localVideoTrack = track
                    self.applyLocalVideoTrack(track)
                }
                nativeCallDiag("outgoing_cam_preview_started", cid)
            } catch {
                nativeCallDiag("outgoing_cam_preview_failed", cid, String("\(error)".prefix(160)))
                await MainActor.run {
                    guard let self = self, self.outgoingPreviewTrack === track else { return }
                    self.outgoingPreviewTrack = nil
                }
            }
        }
    }

    /// Stops the never-published ringing preview (hang-up / dismissed before
    /// answer) so the camera (green dot) turns off. No-op once published —
    /// LiveKit owns published tracks.
    private func stopOutgoingCameraPreview() {
        guard let pv = outgoingPreviewTrack else { return }
        outgoingPreviewTrack = nil
        Task { try? await pv.stop() }
    }

    /// [2026-10-14 self-view] Tap the self-view tile = swap: my camera full
    /// screen, the peer in the tile (tap again to swap back). Only while both
    /// videos exist; any track change resets to the normal layout.
    @objc private func handleLocalPipTap() {
        guard let remote = remoteVideoView, let local = localVideoView else { return }
        guard let remoteTrack = session.remoteVideoTrack, let localTrack = session.localVideoTrack,
              session.camEnabled, !remote.isHidden else { return }
        videoSwapped.toggle()
        resetRemoteZoom()
        if videoSwapped {
            remote.track = localTrack
            remote.layoutMode = .fill
            remote.mirrorMode = (currentCameraPosition == .front) ? .mirror : .off
            local.track = remoteTrack
            local.mirrorMode = .off
            local.layoutMode = (remoteTrack.source == .screenShareVideo) ? .fit : .fill
        } else {
            restoreVideoSwap()
        }
        resetControlsAutoHide()
    }

    /// Put renderers back in the normal layout (peer full screen, me in tile).
    private func restoreVideoSwap() {
        videoSwapped = false
        guard let remote = remoteVideoView, let local = localVideoView else { return }
        remote.mirrorMode = .off
        if let rt = session.remoteVideoTrack {
            remote.layoutMode = (rt.source == .screenShareVideo) ? .fit : .fill
            remote.track = rt
        }
        local.layoutMode = .fill
        local.mirrorMode = (currentCameraPosition == .front) ? .mirror : .off
        if let lt = session.localVideoTrack { local.track = lt }
    }

    /// Bind / unbind the local camera into the PiP tile. Visible only while the
    /// camera is enabled (session.camEnabled). Mirrors the front camera.
    private func applyLocalVideoTrack(_ track: LocalVideoTrack?) {
        // [2026-10-16 wave13-B efeitos] Frame tap (blur / fundo / luz) on the
        // camera behind this track — idempotent; pass-through when no effect.
        if let t = track { CallFx.shared.attach(t) }
        guard let local = localVideoView, localPipContainer != nil else { return }
        if videoSwapped { restoreVideoSwap() }   // [2026-10-14 self-view]
        if let track = track, session.camEnabled {
            local.track = track
            // mirrorMode = .auto handles front-camera mirroring; pin explicitly
            // as defense-in-depth across LK Swift revs where .auto regressed.
            local.mirrorMode = (currentCameraPosition == .front) ? .mirror : .off
            showLocalPip(true)
            // First publish on a video call: surface the flip control too.
            updateFlipButtonVisibility(true)
        } else {
            // Detach when no track; keep the tile hidden when cam disabled.
            if track == nil { local.track = nil }
            showLocalPip(false)
            updateFlipButtonVisibility(false)
        }
    }

    /// Show / hide the local PiP tile with a fade.
    private func showLocalPip(_ show: Bool) {
        guard let pip = localPipContainer else { return }
        if show {
            // [2026-10-15 cam-1-toque] Self-view pops in (scale + fade spring)
            // the moment the camera goes live — clear feedback for the tap.
            let wasHidden = pip.isHidden || pip.alpha < 0.05
            pip.isHidden = false
            view.bringSubviewToFront(pip)
            if wasHidden {
                pip.transform = CGAffineTransform(scaleX: 0.82, y: 0.82)
                UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.72,
                               initialSpringVelocity: 0.6, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    pip.alpha = 1
                    pip.transform = .identity
                }
            } else {
                UIView.animate(withDuration: 0.2) { pip.alpha = 1 }
            }
        } else {
            UIView.animate(withDuration: 0.2, animations: { pip.alpha = 0 }) { _ in
                if pip.alpha == 0 { pip.isHidden = true }
            }
        }
    }

    // ── Local PiP drag + edge snap ──────────────────────────────────────────
    @objc private func handlePipPan(_ gr: UIPanGestureRecognizer) {
        guard let pip = localPipContainer else { return }
        switch gr.state {
        case .began:
            pipPanOrigin = pip.center
        case .changed:
            let t = gr.translation(in: view)
            pip.center = CGPoint(x: pipPanOrigin.x + t.x, y: pipPanOrigin.y + t.y)
        case .ended, .cancelled:
            // Clamp vertically inside safe-ish bounds, snap horizontally L/R.
            let margin: CGFloat = 14
            let halfW = pip.bounds.width / 2
            let halfH = pip.bounds.height / 2
            let topLimit = view.safeAreaInsets.top + halfH + 8
            let bottomLimit = view.bounds.height - view.safeAreaInsets.bottom - halfH - 120
            var cy = pip.center.y
            cy = min(max(cy, topLimit), max(topLimit, bottomLimit))
            let snapLeft = pip.center.x < view.bounds.width / 2
            let cx = snapLeft ? (margin + halfW) : (view.bounds.width - margin - halfW)
            UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0.6, options: [.allowUserInteraction]) {
                pip.center = CGPoint(x: cx, y: cy)
            }
        default:
            break
        }
    }

    // ── Camera flip ─────────────────────────────────────────────────────────
    @objc private func uikitOnFlipCamera() {
        tapFeedback(view.viewWithTag(9006) as? UIButton)
        // [2026-05-25 flip-crash fix] Guard: if there is no local video track
        // published yet (audio-only call, or video not yet on), flipping the
        // camera has nothing to act on — switchCamera() would otherwise reach
        // into a nil capturer / publish a camera the user never asked for.
        // The flip control is normally hidden until the camera publishes, but
        // the PiP-tile flip button + races can still fire this; bail safely
        // instead of crashing.
        guard session.localVideoTrack != nil, session.camEnabled else {
            print("[CallVC] uikitOnFlipCamera ignored — no local video track / cam disabled")
            return
        }
        switchCamera()
        // Update local mirror immediately for snappy feel; switchCamera flips
        // currentCameraPosition synchronously before the async swap.
        if let local = localVideoView {
            local.mirrorMode = (currentCameraPosition == .front) ? .mirror : .off
        }
        // [2026-10-14 self-view] Swapped layout: my camera is the big view.
        if videoSwapped, let remote = remoteVideoView {
            remote.mirrorMode = (currentCameraPosition == .front) ? .mirror : .off
            localVideoView?.mirrorMode = .off
        }
        // Keep controls visible after interacting.
        resetControlsAutoHide()
    }

    // ── Video-mode controls: scrim + auto-hide + tap-to-toggle ───────────────
    private func enterVideoControlsMode() {
        // [2026-10-14 group-ui] Grid mode: controls stay put (no scrim/auto-hide).
        guard !gridActive else { return }
        // Install a translucent bottom scrim behind the controls so the glass
        // buttons stay legible over arbitrary camera frames.
        if controlsScrim == nil {
            let scrim = UIView()
            scrim.translatesAutoresizingMaskIntoConstraints = false
            scrim.isUserInteractionEnabled = false
            let g = CAGradientLayer()
            g.colors = [
                UIColor.clear.cgColor,
                UIColor.black.withAlphaComponent(0.55).cgColor,
            ]
            g.locations = [0.0, 1.0]
            g.frame = CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 280)
            scrim.layer.addSublayer(g)
            // Insert just below the controls (above remote video).
            if let remote = remoteVideoView {
                view.insertSubview(scrim, aboveSubview: remote)
            } else {
                view.addSubview(scrim)
            }
            NSLayoutConstraint.activate([
                scrim.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                scrim.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                scrim.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                scrim.heightAnchor.constraint(equalToConstant: 280),
            ])
            controlsScrim = scrim
            // Re-front the control bar (9008) + labels so they sit above the
            // scrim. [UI rewrite 2026-05-25] Buttons live inside the bar stack.
            for tag in [9000, 9001, 9008, 9040] {
                if let v = view.viewWithTag(tag) { view.bringSubviewToFront(v) }
            }
            if let bars = view.viewWithTag(9010), let topBar = bars.superview {
                view.bringSubviewToFront(topBar)
            }
            if let pip = localPipContainer { view.bringSubviewToFront(pip) }
        }
        // Tap-to-toggle gesture (installed once).
        if videoTapGesture == nil {
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleVideoScreenTap))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            view.addGestureRecognizer(tap)
            videoTapGesture = tap
        }
        // Pinch-to-zoom on the remote video (installed once).
        if remotePinchGesture == nil, let remote = remoteVideoView {
            remote.isUserInteractionEnabled = true
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handleRemotePinch(_:)))
            remote.addGestureRecognizer(pinch)
            remotePinchGesture = pinch
            // [2026-10-14 screen-share viewer] Drag to pan while zoomed in
            // (reading a shared screen). No-op at 1×.
            let pan = UIPanGestureRecognizer(target: self, action: #selector(handleRemotePan(_:)))
            pan.maximumNumberOfTouches = 2
            remote.addGestureRecognizer(pan)
        }
        controlsHidden = false
        resetControlsAutoHide()
    }

    private func exitVideoControlsMode() {
        controlsHideTimer?.invalidate()
        controlsHideTimer = nil
        // Always show controls when not in video mode.
        setControlsHidden(false, animated: true)
        // Drop the scrim.
        controlsScrim?.removeFromSuperview()
        controlsScrim = nil
    }

    /// Restart the 5s inactivity timer (video mode only).
    private func resetControlsAutoHide() {
        guard remoteVideoActive, !gridActive else { return }
        setControlsHidden(false, animated: true)
        controlsHideTimer?.invalidate()
        controlsHideTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
            self?.setControlsHidden(true, animated: true)
        }
    }

    @objc private func handleVideoScreenTap() {
        guard remoteVideoActive, !gridActive else { return }
        if controlsHidden {
            setControlsHidden(false, animated: true)
            resetControlsAutoHide()
        } else {
            setControlsHidden(true, animated: true)
        }
    }

    /// Fade the control + label + top-bar + scrim views in/out (video mode).
    private func setControlsHidden(_ hidden: Bool, animated: Bool) {
        controlsHidden = hidden
        let targetAlpha: CGFloat = hidden ? 0 : 1
        // [UI rewrite 2026-05-25] Fade the whole control bar (9008) + the
        // name/status labels + participant count + top bar + scrim together.
        // The bar holds every button + its caption, so a single alpha on the
        // stack hides/reveals all controls (and their captions) at once. The
        // flip-camera cell stays hidden independently when the camera is off.
        let tags = [9000, 9001, 9008, 9040]
        let topBar: UIView? = {
            if let bars = view.viewWithTag(9010) { return bars.superview }
            return nil
        }()
        let work = {
            for tag in tags { self.view.viewWithTag(tag)?.alpha = targetAlpha }
            topBar?.alpha = targetAlpha
            self.controlsScrim?.alpha = targetAlpha
        }
        if animated {
            UIView.animate(withDuration: 0.25, animations: work)
        } else {
            work()
        }
    }

    // ── Pinch-to-zoom on remote video (1×–3×, spring back) ───────────────────
    @objc private func handleRemotePinch(_ gr: UIPinchGestureRecognizer) {
        guard let remote = remoteVideoView else { return }
        switch gr.state {
        case .changed:
            let proposed = remoteZoomScale * gr.scale
            let clamped = min(max(proposed, 1.0), 3.0)
            remote.transform = remoteZoomTransform(scale: clamped, offset: clampedRemotePan(remotePanOffset, scale: clamped))
        case .ended, .cancelled:
            // Commit the clamped scale; if at/below 1× spring back to identity.
            let current = remoteZoomScale * gr.scale
            let clamped = min(max(current, 1.0), 3.0)
            if clamped <= 1.01 {
                remoteZoomScale = 1.0
                remotePanOffset = .zero
                UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0.5, options: []) {
                    remote.transform = .identity
                }
            } else {
                remoteZoomScale = clamped
                remotePanOffset = clampedRemotePan(remotePanOffset, scale: clamped)
                remote.transform = remoteZoomTransform(scale: clamped, offset: remotePanOffset)
            }
        default:
            break
        }
    }

    // [2026-10-14 screen-share viewer] Pan while zoomed (WhatsApp-style
    // reading of a shared screen). Offset is clamped so the content edge never
    // leaves the screen edge.
    private var remotePanOffset: CGPoint = .zero
    private var remotePanStart: CGPoint = .zero

    @objc private func handleRemotePan(_ gr: UIPanGestureRecognizer) {
        guard let remote = remoteVideoView, remoteZoomScale > 1.01 else { return }
        switch gr.state {
        case .began:
            remotePanStart = remotePanOffset
        case .changed:
            let t = gr.translation(in: view)
            let proposed = CGPoint(x: remotePanStart.x + t.x, y: remotePanStart.y + t.y)
            remotePanOffset = clampedRemotePan(proposed, scale: remoteZoomScale)
            remote.transform = remoteZoomTransform(scale: remoteZoomScale, offset: remotePanOffset)
        default:
            break
        }
    }

    private func remoteZoomTransform(scale: CGFloat, offset: CGPoint) -> CGAffineTransform {
        return CGAffineTransform(translationX: offset.x, y: offset.y).scaledBy(x: scale, y: scale)
    }

    private func clampedRemotePan(_ p: CGPoint, scale: CGFloat) -> CGPoint {
        let maxX = max(0, (scale - 1) * view.bounds.width / 2)
        let maxY = max(0, (scale - 1) * view.bounds.height / 2)
        return CGPoint(x: min(max(p.x, -maxX), maxX), y: min(max(p.y, -maxY), maxY))
    }

    private func resetRemoteZoom() {
        remoteZoomScale = 1.0
        remotePanOffset = .zero
        remoteVideoView?.transform = .identity
    }
}

// MARK: - RoomDelegate

extension CallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        // [2026-10-15 screen-share] Control-Center starts attach to this room.
        ScreenShareSupport.registerActive(room: room, callId: callId)
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
        // [2026-10-10 call-states] LiveKit does not fire participantDidConnect
        // for peers already in the room at join. Caller: the callee's ring
        // preconnect being there = its phone is ringing → "Tocando…".
        // Callee / answered: arm the media watchdog.
        let presentAtJoin = !room.remoteParticipants.isEmpty
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.isOutgoing && !self.outgoingMicGateOpen {
                if presentAtJoin { self.markPeerRinging(reason: "present_at_join") }
            } else {
                self.scheduleOutgoingConnectFallback(reason: "room_connected", seconds: 8)
            }
        }
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
                if !self.session.isReconnecting {
                    nativeCallDiag("lk_reconnecting", self.callId, "media=\(self.callConnectedAt != nil ? 1 : 0)") // [2026-10-18 call-resilience]
                }
                self.session.status = "Reconectando..."
                self.session.isReconnecting = true
            case .connected:
                if self.session.isReconnecting {
                    nativeCallDiag("lk_reconnected", self.callId, "media=\(self.callConnectedAt != nil ? 1 : 0)") // [2026-10-18 call-resilience]
                    // [2026-10-10 call-states] Back to the REAL phase: only a
                    // call whose media already flowed goes back to "Conectado"
                    // (timer resumes); otherwise restore Chamando/Tocando/
                    // Conectando.
                    self.session.isReconnecting = false
                    self.session.status = (self.callConnectedAt != nil) ? "Conectado" : self.statusDotsBase
                }
            case .disconnected:
                // [2026-10-19 chamada-queda] rejoin com token novo em curso.
                // (didDisconnectWithError chega DEPOIS deste evento: numa
                // ligação com mídia ele decide rejoin ou encerramento e põe o
                // texto certo — sem piscar "Desconectado" antes.)
                if !self.didHangup && (self.appRejoinActive
                    || (self.callConnectedAt != nil && CallResilience.flags().appRejoin)) { break }
                self.session.status = "Desconectado"
                self.session.isReconnecting = false
            default: break
            }
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        ScreenShareSupport.callEnding(room: room, callId: callId)   // [2026-10-15]
        // [CALL-TRACE 2026-05-20 WAVE42] Step 9/12 — RoomDelegate.disconnect.
        NSLog("[CallTrace][9/12] RoomEvent type=Disconnected callId=\(callId) err=\(String(describing: error)) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        print("[CallVC] didDisconnectWithError — error=\(String(describing: error))")
        // [CALL-CLOSE diag 2026-05-27] LK Room disconnected — if this fires
        // right after answer, the SFU/token/network dropped the room (NOT the
        // stale-call_end path). Distinguishes "Room died" from "UI dismissed".
        // [2026-10-11 p2p-keepalive] 1:1 voice whose media is on a CONNECTED
        // P2P path: the LiveKit Room is only a warm standby. Losing it (LK
        // gave up its 10 reconnect attempts during a long network blip that
        // P2P survived via ICE restart) must not hang up a call whose audio is
        // flowing. Keep the call, rejoin the standby Room in the background
        // (P2PCallBridge.publishLiveKitMic also rejoins on a later fallback).
        // error == nil = our own leave (handleHangup) → normal teardown below.
        if error != nil, !didHangup, P2PCallBridge.isConnected(callId), NativeCallRoom.shared.currentRoom() === room {
            nativeCallDiag("lk_disconnect_p2p_keepalive", callId, "err=\(String(describing: error))")
            let cid = callId
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                NativeCallRoom.shared.rejoinIfDead(callId: cid, reason: "p2p_keepalive")
            }
            return
        }
        // [2026-10-19 chamada-queda] O SDK desistiu (resume recusado / rede
        // fora além das 3 tentativas) numa ligação 1:1 com mídia → rejoin na
        // mesma sala com token NOVO (não encerra). Nossa saída (error nil),
        // expulsão, sala apagada e identidade duplicada seguem encerrando.
        if let e = error, Self.isRecoverableDrop(e), CallResilience.flags().appRejoin,
           !didHangup, callConnectedAt != nil {
            let errType = String(describing: e.type)
            nativeCallDiag("lk_disconnect_app_rejoin", callId, "err=\(errType)")
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                if !self.startAppRejoin(room: room, why: "lk_" + errType) {
                    self.teardownAfterLkDisconnect(room, error: error)
                }
            }
            return
        }
        teardownAfterLkDisconnect(room, error: error)
    }

    /// Encerramento clássico após o LiveKit desconectar (era o corpo de
    /// didDisconnectWithError; extraído p/ o rejoin poder cair nele).
    private func teardownAfterLkDisconnect(_ room: Room, error: LiveKitError?) {
        nativeCallDiag("call_close_lk_disconnect", callId, "err=\(String(describing: error))")
        // [#1207 NativeCallRoom REAL] Fanout to JS BEFORE we tear down the
        // session. JS listeners need the disconnect event so they can swap
        // back to the chat header / call list. We also clear() so a future
        // adoptNativeRoom call doesn't see a stale snapshot.
        let reasonStr: String = (error.map { String(describing: $0) }) ?? "remote_ended"
        // [2026-10-11 publisher-nil] Only fan out / clear when the singleton
        // still holds THIS Room (a previous call's Room dying late must not
        // wipe the next call's preconnect Room).
        if NativeCallRoom.shared.currentRoom() === room {
            NativeCallRoom.shared.didDisconnect(reason: reasonStr)
        }
        NativeCallRoom.shared.clear(ifCurrent: room, reason: "callvc_lk_disconnect")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [#1171 redux dismiss, 2026-05-19] Mark didHangup so a follow-up
            // user red-button tap doesn't run the full teardown a second time
            // (Room is already gone; CXEndCallAction would still fire but
            // CallSignalWs.fireCallEnd would duplicate the server-side BYE).
            // Re-entrant calls still trigger forceDismissSelf via handleHangup.
            let endedBefore = self.didHangup // [2026-10-18 call-resilience]
            self.didHangup = true
            // [minimize-drop fix 2026-05-26] Peer ended the call (possibly
            // while we were minimized). Clear the minimize flag + holder so the
            // VC can dealloc and the OngoingCallBar / PiP surfaces get torn down
            // by forceDismissSelf below. The Room is already gone (cleared
            // above), so deinit's room-teardown is a no-op either way.
            self.isMinimizing = false
            CallViewController.minimizedInstance = nil
            // [2026-10-20 callend-reload] Minimizada (barra "voltar à ligação" /
            // PiP) e o outro lado desligou: tira a barra nativa, para o PiP e
            // avisa o snapshot do JS — antes só o handleHangup fazia isso.
            OngoingCallBarOverlayController.shared.uninstall()
            if #available(iOS 15.0, *), let pip = self.pipController, pip.isPictureInPictureActive {
                pip.stopPictureInPicture()
            }
            OngoingCallState.shared.notifyChanged()
            ExpoCallKitModule.ensureCallKitEnded(callId: self.callId,
                                                 reason: error != nil ? .failed : .remoteEnded,
                                                 src: "lk_disconnect")
            // [2026-10-18 call-resilience] LiveKit gave up its own reconnect
            // (network/timeout class error) on a call whose media flowed →
            // WhatsApp "Chamada encerrada — conexão perdida".
            self.stopCallResilience()
            let lostText: String? = endedBefore ? nil : Self.connectionLostText(error: error, mediaFlowed: self.callConnectedAt != nil)
            if lostText != nil {
                let errType: String = error.map { String(describing: $0.type) } ?? "nil"
                nativeCallDiag("call_end_connection_lost", self.callId, "reason=lk_" + errType)
            }
            // [#1171 redux dismiss, 2026-05-19] Update visible status BEFORE
            // teardown so the user sees the call is ending — same rationale
            // as handleHangup. Mostly relevant for peer-end / network-drop
            // where the user didn't tap hangup themselves.
            self.session.status = lostText ?? "Encerrada"
            if let t = lostText { CallEndNotice.show(t, delay: 0.6) }
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
        let hasMedia = !participant.trackPublications.isEmpty // [2026-10-14 group-ui]
        let lkName = participant.name
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [2026-10-10 call-states] ringback stop moved into the post-answer
            // branch below — the callee's ring preconnect must NOT silence it.
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
            // [2026-10-06 native-only outgoing] For the CALLER a peer joining the
            // SFU is NOT proof of answer: Android (FCM) and iOS (VoIP push)
            // callees pre-connect subscribe-only DURING the ring, so the WAVE 161
            // flip here started the timer while the callee's phone was still
            // ringing. Commit only when the answer gate is already open (WS
            // call_accepted landed); otherwise arm a 6s fallback that flips if
            // the peer is still present and nothing else confirmed (lost WS
            // frame + callee whose mic publishes nothing). Incoming unchanged.
            // [2026-10-10 call-states] Presence is NEVER "Conectado" (not even
            // after the answer — the callee publishes on Accept, so media
            // follows within ~1s and didSubscribeTrack commits it). Pre-answer
            // presence = the callee's ring preconnect = its phone is ringing →
            // "Tocando…", ringback keeps playing. Post-answer / incoming: make
            // sure the connect watchdog is armed.
            // [2026-10-12 peer-gone] Peer back inside the grace window → resume.
            self.restoreAfterPeerBack(reason: "participant_connected")
            if self.isOutgoing && !self.outgoingMicGateOpen {
                NSLog("[CallVC] ParticipantConnected pre-answer (outgoing) — callee ringing → Tocando callId=\(self.callId)")
                self.markPeerRinging(reason: "participant_connected")
            } else {
                if self.isOutgoing { self.stopRingbackTone(reason: "participantDidConnect") }
                self.scheduleOutgoingConnectFallback(reason: "participant_connected", seconds: 8)
            }
            self.remoteParticipantCount += 1
            self.updateParticipantCountLabel()
            // [2026-10-14 group-ui] Grid bookkeeping. Joined without media =
            // ring preconnect (or an answer whose mic lands in a moment): still
            // silent after 1.5 s and not the 1:1 peer → "Tocando…".
            if hasMedia {
                self.gridNoteMedia(identity: identity, lkName: lkName)
            } else {
                let bare = GroupCallViewController.bareEmail(identity)
                if bare != self.peerBareEmail && bare != self.myBareEmail {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self = self, !self.didHangup else { return }
                        guard !self.gridAnnounced.contains(identity), self.gridRinging[bare] == nil,
                              let rp = self.room?.remoteParticipants.values.first(where: { $0.identity?.stringValue == identity }),
                              rp.trackPublications.isEmpty else { return }
                        self.gridRinging[bare] = self.gridName(identity: identity, lkName: lkName)
                        self.scheduleGridRingingExpiry(bare)
                        self.requestGridRebuild()
                    }
                }
            }
            self.requestGridRebuild()
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
        let lkName = participant.name // [2026-10-14 group-ui]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // 1:1 fallback: clear the remote video track when the peer leaves.
            self.session.remoteVideoTrack = nil
            // Peer is gone — drop any muted-camera stash so it can't be restored.
            self.remoteVideoMuted = false
            self.mutedRemoteVideoTrack = nil
            self.remoteParticipantCount = max(0, self.remoteParticipantCount - 1)
            self.updateParticipantCountLabel()
            // [2026-10-14 group-ui] "Fulano saiu" when someone who was really in
            // the call leaves and the call goes on; never-answered → just drop.
            let bare = GroupCallViewController.bareEmail(identity)
            let wasInCall = self.gridAnnounced.remove(identity) != nil
            self.gridRinging.removeValue(forKey: bare)
            let me = self.myBareEmail
            let othersLeft = self.room?.remoteParticipants.values.contains(where: {
                let b = GroupCallViewController.bareEmail($0.identity?.stringValue ?? "")
                return !b.isEmpty && b != bare && b != me
            }) ?? false
            if wasInCall && othersLeft {
                self.showGridToast(GroupCallStrings.s("gx.left", ["name": self.gridName(identity: identity, lkName: lkName)]))
            }
            self.requestGridRebuild()
            // [2026-10-12 peer-gone] 1:1: last remote gone after media → grace.
            self.startPeerGoneGrace(identity: identity)
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
        // [2026-10-11 full-hd] "Economizar dados" → MEDIUM (540p) layer.
        Self.applyReceivePreference(publication)
        // [2026-07-15 media-truth connect] The outgoing CALLER flips to
        // "Conectado" only via participantDidConnect (LK skips peers already
        // in the room — the callee preconnects subscribe-only BEFORE answering,
        // so it's present when the caller connects → callback never fires),
        // the remoteAnsweredObserver (needs the WS call_accepted frame, which
        // rides the now-dead chatyy_live_events path), or the incoming-only
        // STAGE-A adopt. So the caller stayed on "Chamando…" forever even
        // though media flowed (QA Lester: audio + camera work, screen still
        // ringing). The FIRST subscribed remote track of ANY kind is genuine
        // post-answer media-truth (the callee publishes nothing during the
        // ring), so flip here — BEFORE the video-only guard so audio-only calls
        // are covered too. Idempotent: setting session.status drives the
        // statusObserver sink (→ callConnectedAt + stops the "Chamando…" dots
        // timer); guarded so a later WS/participantDidConnect flip is a no-op,
        // and stopRingbackTone is guarded by ringbackActive.
        let subName = participant.name // [2026-10-14 group-ui]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [2026-10-14 group-ui] First media = in the call (grid tile / notice).
            self.gridNoteMedia(identity: identity, lkName: subName)
            self.openOutgoingMicGate(reason: "remote_track_subscribed")
            self.stopRingbackTone(reason: "didSubscribeTrack_mediaTruth")
            // [2026-10-06 native-only outgoing] First remote media = Conectado
            // (+ CallKit connectedAt + duration timer).
            self.markCallConnected(reason: "remote_track_subscribed")
            // Audio-only outgoing: re-assert the earpiece when the first remote
            // audio starts. The LK audio-session reconfigure that runs at that
            // moment tends to reset the route to the loudspeaker ("presa no
            // viva-voz", 2026-10-04 — fixed in /call.js then; native owns it
            // now). overrideOutputAudioPort(.none) = system default, so a BT /
            // wired headset keeps winning. Skipped once the user touched the
            // speaker button.
            // [2026-10-07 audio-route] The real fix is AudioRouter's LiveKit
            // AudioManager hook (LiveKit no longer flips the session to
            // .videoChat on track start). This re-assert is kept as a cheap
            // belt-and-braces, now via reapplyRoute() (category/mode AND
            // override, respects a user's speaker choice and BT/AirPods) for
            // incoming too, instead of a bare override(.none) that was a no-op
            // under .videoChat.
            if kind == "audio", !self.hasVideo, !self.speakerTouchedByUser {
                for delayMs in [0, 400, 1200, 2500] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs)) { [weak self] in
                        guard let self = self, !self.speakerTouchedByUser, !self.didHangup else { return }
                        AudioRouter.shared.reapplyRoute()
                    }
                }
            }
        }
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else {
            print("[CallVC] didSubscribeTrack — video pub but track cast failed")
            return
        }
        print("[CallVC] didSubscribeTrack — remote video, identity=\(identity) muted=\(publication.isMuted)")
        let arrivedMuted = publication.isMuted
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [2026-10-08 call-video-fix] A camera that arrives already MUTED
            // (peer turned it off before we subscribed / re-subscribe after a
            // reconnect) must show the avatar placeholder, not a black tile.
            // Stash it so didUpdateIsMuted(false) re-binds the same track.
            if arrivedMuted {
                self.remoteVideoMuted = true
                self.mutedRemoteVideoTrack = track
                self.stopRingbackTone(reason: "didSubscribeTrack")
                return
            }
            // [2026-10-11 call-parity] The peer's SCREEN keeps the full-bleed
            // tile: a camera (re)subscribed while a screen share shows must not
            // replace it (didUnsubscribeTrack falls back to the camera when the
            // share ends).
            if publication.source != .screenShareVideo,
               let cur = self.session.remoteVideoTrack, cur.source == .screenShareVideo {
                self.stopRingbackTone(reason: "didSubscribeTrack")
                return
            }
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
        DispatchQueue.main.async { [weak self] in self?.requestGridRebuild() } // [2026-10-14 group-ui]
        guard publication.kind == .video else { return }
        print("[CallVC] didUnsubscribeTrack — remote video gone")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let track = self.pipAttachedTrack, let renderer = self.pipRenderer {
                track.remove(videoRenderer: renderer)
            }
            self.pipAttachedTrack = nil
            self.session.remoteVideoTrack = nil
            // Track is truly gone now (unpublished) — drop the muted-state stash
            // so a later spurious unmute can't try to re-bind a dead track.
            self.remoteVideoMuted = false
            self.mutedRemoteVideoTrack = nil
            // [2026-10-06 screen-share iOS] The peer may publish camera AND
            // screen share at once; the full-bleed tile shows whichever was
            // subscribed last. When one of them goes away (typically the
            // screen share ending), fall back to the other still-subscribed
            // remote video instead of dropping to the avatar.
            if let fallback = participant.videoTracks
                .first(where: { "\($0.sid)" != "\(publication.sid)" && ($0.track as? VideoTrack) != nil })?
                .track as? VideoTrack {
                print("[CallVC] didUnsubscribeTrack — falling back to remaining remote video (source=\(fallback.source))")
                self.session.remoteVideoTrack = fallback
                if #available(iOS 15.0, *) {
                    self.attachPiPRenderer(to: fallback)
                }
            }
            // [2026-10-14 pip-frozen] no remote video left → avatar card in PiP now.
            if self.pipAttachedTrack == nil { self.refreshPiPPlaceholder() }
        }
    }

    /// [2026-10-14 group-ui] A remote published (mic/camera/screen) = they are
    /// in the call → grid tile leaves "Tocando…", notice, refresh.
    func room(_ room: Room,
              participant: RemoteParticipant,
              didPublishTrack publication: RemoteTrackPublication) {
        let identity = participant.identity?.stringValue ?? "?"
        let lkName = participant.name
        DispatchQueue.main.async { [weak self] in
            self?.gridNoteMedia(identity: identity, lkName: lkName)
        }
    }

    // [2026-10-06 screen-share iOS] LOCAL publish/unpublish — the truth for the
    // "Tela" toggle. With the broadcast extension the SDK publishes the
    // screen-share track only after the user confirms the system sheet, and
    // unpublishes when the broadcast ends (red pill / extension killed), so
    // the UI must follow these events rather than the toggle call returning.
    func room(_ room: Room,
              participant: LocalParticipant,
              didPublishTrack publication: LocalTrackPublication) {
        guard publication.source == .screenShareVideo else { return }
        print("[CallVC] local screen-share published sid=\(publication.sid)")
        nativeCallDiag("screen_share_published", callId, ScreenShareSupport.useBroadcastExtension ? "broadcast" : "in_app")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.screenShareInFlight = false
            self.applyScreenShareState(true)
        }
    }

    func room(_ room: Room,
              participant: LocalParticipant,
              didUnpublishTrack publication: LocalTrackPublication) {
        guard publication.source == .screenShareVideo else { return }
        print("[CallVC] local screen-share unpublished sid=\(publication.sid)")
        nativeCallDiag("screen_share_unpublished", callId)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.screenShareInFlight = false
            self.applyScreenShareState(false)
        }
    }

    /// [2026-05-26 remote-camera-off fix] Remote peer toggled a track's muted
    /// state. WhatsApp / most clients turn the camera OFF by MUTING the
    /// publication (the SFU keeps forwarding "muted") rather than unpublishing,
    /// so this — NOT didUnsubscribeTrack — is what fires when the Android peer
    /// taps "camera off". The old code had no handler, so the remote VideoView
    /// kept rendering the last (now frozen / black) frame: the call looked
    /// "broken / video stopped" even though audio + the session were perfectly
    /// alive.
    ///
    /// Fix: on remote VIDEO mute, swap to the avatar "camera off" placeholder
    /// while KEEPING the call (and the still-subscribed track) alive; on unmute
    /// re-bind the exact same track and the picture returns instantly. We never
    /// touch audio, the Room, or the local camera here — only the remote tile's
    /// presentation. Audio-track mutes are ignored (the speaking-ring / mic
    /// indicator path owns those).
    func room(_ room: Room,
              participant: Participant,
              trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        // [2026-10-14 group-ui] Grid tiles show mic-muted / camera-off for all.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.gridActive || !self.gridRinging.isEmpty else { return }
            self.requestGridRebuild()
        }
        // Only care about REMOTE video here. Local mic/cam + remote audio are
        // handled elsewhere (mute button, speaking ring).
        guard trackPublication.kind == .video else { return }
        guard (participant as? RemoteParticipant) != nil else { return }
        let identity = participant.identity?.stringValue ?? "?"
        print("[CallVC] remote video \(isMuted ? "MUTED (camera off)" : "UNMUTED (camera on)") — identity=\(identity)")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // [2026-10-11 call-parity] Camera muted/unmuted BEHIND a live screen
            // share: leave the screen on the tile.
            if trackPublication.source != .screenShareVideo,
               let cur = self.session.remoteVideoTrack, cur.source == .screenShareVideo {
                return
            }
            if isMuted {
                // Remember the live track so we can restore it on unmute, then
                // show the avatar placeholder. applyRemoteVideoTrack(nil) only
                // swaps the UI (hides the VideoView, fades the avatar back in) —
                // it does NOT tear down the call or the Room.
                self.remoteVideoMuted = true
                if let current = self.session.remoteVideoTrack {
                    self.mutedRemoteVideoTrack = current
                }
                // Detach the PiP renderer so it doesn't sit on a frozen frame.
                if let track = self.pipAttachedTrack, let renderer = self.pipRenderer {
                    track.remove(videoRenderer: renderer)
                    self.pipAttachedTrack = nil
                }
                // [2026-10-14 pip-frozen] detaching alone left the last frame on
                // the display layer → swap to the avatar card right away.
                self.refreshPiPPlaceholder()
                self.session.remoteVideoTrack = nil
            } else {
                // Camera back on — re-bind the same track (or the publication's
                // current track if our stash is stale) and the video returns.
                self.remoteVideoMuted = false
                let restore = (trackPublication.track as? VideoTrack) ?? self.mutedRemoteVideoTrack
                self.mutedRemoteVideoTrack = nil
                if let track = restore {
                    self.session.remoteVideoTrack = track
                    if #available(iOS 15.0, *) {
                        self.attachPiPRenderer(to: track)
                    }
                }
                // If we couldn't recover a track here, didSubscribeTrack will
                // re-bind it when the SFU re-forwards frames — call stays alive.
            }
        }
    }

    /// Active speaker — LiveKit emits this whenever the SFU's audio-energy
    /// snapshot changes. For 1:1 we just flip the green ring; for group, the
    /// GroupCallViewController has its own delegate.
    func room(_ room: Room, didUpdateSpeakingParticipants speakers: [Participant]) {
        let remoteSpeaking = speakers.contains { ($0 as? RemoteParticipant) != nil }
        let speakingIds = Set(speakers.compactMap { $0.identity?.stringValue }) // [2026-10-14 group-ui]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.session.remoteIsActiveSpeaker = remoteSpeaking
            if self.gridSpeaking != speakingIds {
                self.gridSpeaking = speakingIds
                if self.gridActive { self.requestGridRebuild() }
            }
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
        // [2026-10-11 full-hd] WhatsApp "Conexão fraca" pill: POOR/LOST on
        // either side (lost maps to the default branch).
        let isLocal = participant.identity?.stringValue == room.localParticipant.identity?.stringValue
        let isWeak: Bool
        switch quality {
        case .excellent, .good: isWeak = false
        case .poor, .lost: isWeak = true
        default: isWeak = false // .unknown
        }
        // [2026-10-14 group-ui] Per-tile quality bars in grid mode.
        let gridScore: Int
        switch quality {
        case .excellent: gridScore = 3
        case .good:      gridScore = 2
        case .poor:      gridScore = 1
        default:         gridScore = 0
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.setWeakConnection(local: isLocal, isWeak: isWeak)
            if !isLocal, self.gridQuality[identity] != gridScore {
                self.gridQuality[identity] = gridScore
                if self.gridActive { self.requestGridRebuild() }
            }
        }
        // Only react locally for the local participant; remote participants'
        // quality bars don't surface in the 1:1 UI.
        guard isLocal else { return }
        let score: Int
        switch quality {
        case .excellent: score = 3
        case .good:      score = 2
        case .poor:      score = 1
        default:         score = 0
        }
        DispatchQueue.main.async { [weak self] in
            self?.session.connectionQuality = score
            // [2026-10-11 full-hd] feeds the adaptive capture controller.
            self?.noteLocalConnectionQuality(score)
        }
    }

    /// Data-channel reactions. Filter to messages we know how to handle
    /// (`R:<emoji>`); anything else is ignored.
    func room(_ room: Room,
              participant: RemoteParticipant?,
              didReceiveData data: Data,
              forTopic topic: String) {
        // [2026-10-09] A assinatura com `encryptionType:` NÃO existe no
        // LiveKitClient 2.0.18 (RoomDelegate.swift:144) → método opcional @objc
        // nunca era chamado: video_request e reações não chegavam no 1:1
        // nativo. Mesma assinatura do GroupCallViewController.
        guard let str = String(data: data, encoding: .utf8) else { return }
        // [2026-10-11 call-parity] In-band control frames (same wire format as
        // Android CallActivity.handleControlFrame): call_end (peer leaving —
        // sent BEFORE it leaves), reaction, hold.
        if str.hasPrefix("{"), let cd = str.data(using: .utf8),
           let ctl = (try? JSONSerialization.jsonObject(with: cd)) as? [String: Any],
           let type = ctl["type"] as? String,
           type == "call_end" || type == "reaction" || type == "hold" {
            DispatchQueue.main.async { [weak self] in
                guard let self = self, !self.didHangup else { return }
                switch type {
                case "call_end":
                    let cid = (ctl["call_id"] as? String) ?? ""
                    if !cid.isEmpty && cid != self.callId { return }
                    // A participant added mid-call leaving must not end it for the rest.
                    if let r = self.room, r.remoteParticipants.count >= 2 {
                        nativeCallDiag("remote_end_ignored_group", self.callId, "remotes=\(r.remoteParticipants.count)")
                        return
                    }
                    let why = (ctl["reason"] as? String) ?? "remote_hangup"
                    nativeCallDiag("remote_end", self.callId, "src=lk_data reason=\(why)")
                    self.handleHangup(reason: "remote_hangup", statusText: "Encerrada")
                case "reaction":
                    if let e = ctl["emoji"] as? String, !e.isEmpty {
                        self.showFloatingReaction(e)
                    }
                default: // hold
                    let on = (ctl["on"] as? Bool) ?? ((ctl["on"] as? NSNumber)?.boolValue ?? false)
                    self.peerOnHold = on
                    nativeCallDiag("peer_hold", self.callId, "on=\(on ? 1 : 0)")
                    if let lbl = self.view.viewWithTag(9001) as? UILabel, self.callConnectedAt != nil {
                        let who = self.callerName.isEmpty ? self.callerEmail : self.callerName
                        if on { lbl.text = CallStrings.s("peerOnHold", ["name": who]) }
                    }
                }
            }
            return
        }
        // [2026-06-01 VIDEO PARITY] Handle the `video_request` handshake the JS
        // (/call.js) and Android (CallActivity.kt) sides already speak. ROOT
        // CAUSE of "quando muda pra vídeo o outro vê mas quem ligou não vê": iOS
        // had ZERO video_request handling, so when the peer (or the JS caller)
        // turned on their camera and sent {type:video_request,action:request},
        // iOS ignored it → never enabled ITS camera → the requester never got a
        // remote video track to render → one-way video. (2026-10-15: no more
        // auto-accept — the user is asked, see presentVideoRequestPrompt.)
        if str.hasPrefix("{"), let jd = str.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: jd)) as? [String: Any],
           (obj["type"] as? String) == "video_request" {
            let action = (obj["action"] as? String) ?? ""
            if action == "request" {
                // [2026-10-15 founder] ASK first (WhatsApp): never auto-enable
                // our camera. The peer's video still shows (remote track →
                // video layout); a card "{name} quer mudar para vídeo"
                // Aceitar/Recusar decides OUR camera. Accept = same flow as a
                // tap on "Vídeo"; Recusar = `declined` back (Android/JS clear
                // their awaiting state on it).
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, !self.didHangup else { return }
                    if self.session.camEnabled { return } // already on
                    nativeCallDiag("video_request_prompt", self.callId)
                    self.presentVideoRequestPrompt()
                }
            }
            return
        }
        guard str.hasPrefix("R:") else { return }
        let emoji = String(str.dropFirst(2))
        DispatchQueue.main.async { [weak self] in
            self?.showFloatingReaction(emoji.isEmpty ? "🎉" : emoji)
        }
    }
}

// MARK: - AVPictureInPictureControllerDelegate

@available(iOS 15.0, *)
extension CallViewController: AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        print("[CallVC] PiP will start")
        // [2026-10-07 ios-native] full-rate I420 conversion while visible.
        pipRenderer?.isPiPActive = true
        startPiPStallWatch() // [2026-10-14 pip-frozen]
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
        // [2026-10-11 ongoing-call] PiP can also start on its own (app goes to
        // background → willResignActive observer). Park + flag as a minimize
        // in that path too, or the dismiss would dealloc us and deinit would
        // tear the live Room down.
        if !didHangup {
            isMinimizing = true
            CallViewController.minimizedInstance = self
        }
        dismiss(animated: false) {
            OngoingCallState.shared.notifyChanged()
        }
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController,
                                    failedToStartPictureInPictureWithError error: Error) {
        print("[CallVC] PiP failed to start: \(error)")
        pipRenderer?.isPiPActive = false
        stopPiPStallWatch() // [2026-10-14 pip-frozen]
    }
    func pictureInPictureControllerWillStopPictureInPicture(_ controller: AVPictureInPictureController) {
        print("[CallVC] PiP will stop")
        pipRenderer?.isPiPActive = false
        stopPiPStallWatch() // [2026-10-14 pip-frozen]
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
        // [minimize-drop fix 2026-05-26] We're un-minimizing — a later dismiss
        // must be re-evaluated as a possible real hangup, not swallowed.
        isMinimizing = false
        if let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first {
            var top: UIViewController = root
            while let presented = top.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            top.present(self, animated: false) {
                // [minimize-drop fix 2026-05-26] Presenter holds the strong ref
                // again — release the minimize holder.
                CallViewController.minimizedInstance = nil
                completionHandler(true)
            }
        } else {
            // Couldn't re-present (no scene). Keep the holder so we aren't
            // deallocated (which would disconnect the Room) — a later restore
            // attempt can still find us.
            completionHandler(false)
        }
    }
}

// MARK: - Video-mode tap gesture delegate (#1358, 2026-05-25)

extension CallViewController: UIGestureRecognizerDelegate {
    /// The tap-to-toggle-controls gesture lives on the root `view`. Don't fire
    /// it when the touch lands on an interactive control (any UIButton) or on
    /// the local PiP tile — those have their own actions / drag gesture. This
    /// keeps "tap controls" from immediately hiding the controls the user just
    /// reached for, and keeps the PiP draggable without toggling.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === videoTapGesture else { return true }
        if let hit = touch.view {
            if hit is UIControl { return false }
            // Walk up to see if the touch is inside the PiP tile.
            var v: UIView? = hit
            while let cur = v {
                if cur === localPipContainer { return false }
                v = cur.superview
            }
        }
        return true
    }
}

// MARK: - PiP video renderer
//
// [2026-10-07 ios-native] PiPVideoRenderer + PiPSampleBufferView moved to
// PiPSampleBufferView.swift (I420 support, rotation, layer sizing).
