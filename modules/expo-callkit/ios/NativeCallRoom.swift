import Foundation
import UIKit
import CryptoKit
import LiveKitClient

/**
 * NativeCallRoom — REAL (2026-05-19, task #1207)
 *
 * Holds a strong reference to the **single** LiveKit `Room` instance owned by
 * `CallViewController`. JS (`app/call.js` -> `adoptNativeRoom()`) consults
 * this singleton instead of constructing its own duplicate `Room`. That
 * eliminated the dual-Room SFU conflict that caused:
 *   - audio fighting on iOS (two participants with same identity, both
 *     publishing mic, SFU mixing both into one downlink => echo / cut-out)
 *   - lock-screen viva voz bug (system AudioSession owned by native CallKit
 *     path while the JS-spawned Room reset .voiceChat mode behind its back)
 *   - delay post-answer (JS had to fetch its own token + connect AFTER native
 *     had already finished connecting; user heard 3-6s of silence)
 *
 * Architecture:
 *   1. `CallViewController.viewDidLoad` builds a `Room(delegate: self, ...)`
 *      and after the first connect await **calls `publish(room:callId:roomName:)`**
 *      on this singleton — exposing its Room to the rest of the process.
 *   2. Each `RoomDelegate` callback in CallViewController calls the matching
 *      forwarder here (`didConnect`, `didDisconnect`, etc.). Each forwarder
 *      translates to a `NativeCallRoomEvent` and broadcasts it to the
 *      registered `NativeCallRoomListener` (the Expo module).
 *   3. The Expo module's listener extension (line ~2015 of ExpoCallKitModule)
 *      maps each enum case to `safeSendEvent("onLk...", ...)` so JS receives
 *      `onLkConnected/onLkDisconnected/onLkParticipant...` events identical
 *      in shape to what livekit-client emits — JS treats this Room exactly
 *      as if it had connected the Room itself.
 *   4. `getSnapshot()` returns the live Room state (connected, identity,
 *      participants) so `adoptNativeRoom()` can hand JS a ready-made snapshot
 *      and short-circuit any client-side Room.connect.
 *
 * Listener model:
 *   Kept the enum-based `NativeCallRoomListener` from the stub era because
 *   ExpoCallKitModule already conforms via extension. `addListener` (called
 *   from the module's `adoptNativeRoom` AsyncFunction) is the registration
 *   point; we hold a weak reference to avoid retain cycles. Multiple
 *   listeners are supported but in practice only the module registers.
 *
 * Threading:
 *   All mutations of `room`, `_callId`, `_roomName` happen on the main thread
 *   (CallViewController calls `publish` from `viewDidLoad` / a `MainActor.run`
 *   block, and the delegate forwarders are invoked from RoomDelegate which LK
 *   guarantees on the main actor). `setMicEnabled` / `setCameraEnabled` /
 *   `disconnect` spin a `Task` to use LK's async API.
 */

/// Listener protocol bridging native LK events to the Expo Module's safeSendEvent.
public protocol NativeCallRoomListener: AnyObject {
    func nativeCallRoom(_ room: NativeCallRoom, didEmit event: NativeCallRoomEvent)
}

/// Mirrors the JS-visible onLk* event surface.
public enum NativeCallRoomEvent {
    case connected(roomName: String, localIdentity: String)
    case disconnected(reason: String)
    case participantConnected(identity: String, name: String?)
    case participantDisconnected(identity: String)
    case trackSubscribed(participantIdentity: String, trackSid: String, kind: String)
    case trackUnsubscribed(participantIdentity: String, trackSid: String, kind: String)
    case connectionQualityChanged(participantIdentity: String, quality: String)
}

@objc public class NativeCallRoom: NSObject {

    @objc public static let shared = NativeCallRoom()

    public enum State: String {
        case idle, connecting, connected, disconnected, failed
    }

    // --- Public observable state (read by ExpoCallKitModule) -----------------

    public private(set) var state: State = .idle
    public private(set) var lastRoomName: String?
    public private(set) var lastIdentity: String?

    // --- Internal --------------------------------------------------------------

    /// The single LK Room owned by CallViewController. Strong reference so the
    /// Room survives even if the VC is dismissed mid-call (PiP path).
    private var room: Room?
    private var _callId: String?

    /// Weak listener box — module is retained by Expo runtime; we don't want
    /// to add a retain cycle. NSHashTable handles weak storage + dedupe.
    private let listeners = NSHashTable<AnyObject>.weakObjects()

    // [2026-10-06 native-only outgoing] Backward-compat for an OLD JS bundle
    // still running the legacy flow (push /call.js → adoptNativeRoom →
    // dismissNativeCallVC) against THIS native build. When the outgoing
    // CallViewController is dismissed/deallocated before the callee answers,
    // nobody is left to open its ring-leak mic gate (openOutgoingMicGate lived
    // on the VC) — root cause of "caller never published audio" seen in the
    // SFU logs on 2026-10-05. The watcher below outlives the VC: it listens
    // for the same two answered signals (WS call_accepted notification OR the
    // first remote track) and publishes the caller mic/camera on the shared
    // Room. Armed only from CallViewController.dismissIfPresented for an
    // outgoing VC whose gate is still closed; cleared with the Room.
    private var outgoingAnswerWatcher: OutgoingAnswerWatcher?

    // [2026-10-08 call-connect-fast] Incoming publish-on-answer, single-flight.
    // Before: the callee's mic was published ONLY from CallViewController
    // .viewDidLoad (adopt branch), i.e. after the VC presentation finished —
    // voip_diag shows voipstub_present_autoaccept → present_completion
    // ~1.2-1.7 s after the CXAnswer tap, and the SFU log shows the callee's
    // MICROPHONE published ~1.5 s after call_answered. The caller hears
    // nothing until that publish lands. Now both CXAnswer handlers arm
    // `markIncomingAnswered`; the mic publishes as soon as CallKit activates
    // the audio session (didActivate → ExpoCallKitAudioSessionActivated — the
    // "session already live" ordering incoming always relied on), with a 1 s
    // safety timer. The VC adopt path joins the SAME Task (no 2nd publish).
    // All four members are touched on the main thread only.
    private var answeredIncomingCallId: String?
    private var answeredAudioObserver: NSObjectProtocol?
    private var micPublishCallId: String?
    private var micPublishTask: Task<LocalTrackPublication?, Never>?

    // --- Publication API (called from CallViewController) ---------------------

    /// CallViewController calls this AFTER its own Room.connect await
    /// resolves. After this, JS `adoptNativeRoom(callId)` will see a non-nil
    /// connected snapshot and skip its own Room.connect.
    public func publish(room: Room, callId: String, roomName: String) {
        self.room = room
        self._callId = callId
        self.lastRoomName = roomName
        // Identity may not be available the instant Room.connect resolves;
        // grab the best-effort value now, the `didConnect` forwarder updates
        // it once LK has populated localParticipant.identity.
        self.lastIdentity = room.localParticipant.identity?.stringValue
        self.state = (room.connectionState == .connected) ? .connected : .connecting
        print("[NativeCallRoom] publish: room=\(roomName) callId=\(callId) state=\(state.rawValue)")
    }

    /// CallViewController calls this on hangup / dismiss so the singleton
    /// doesn't hand JS a stale snapshot for the next call.
    public func clear() {
        if room != nil {
            print("[NativeCallRoom] clear: dropping room reference (callId=\(_callId ?? "<nil>"))")
        }
        // [2026-10-06 native-only outgoing] Tear down the answer watcher and
        // restore automatic LK audio mode with the Room (idempotent).
        disarmOutgoingAnswerWatcher()
        LKAudioSessionCallKitBridge.disarm(reason: "room_clear")
        // [2026-10-08 call-connect-fast] Forget the per-call answer state
        // (main-thread-only members).
        if Thread.isMainThread {
            self.answeredIncomingCallId = nil
            self.micPublishCallId = nil
            self.micPublishTask = nil
        } else {
            DispatchQueue.main.async {
                self.answeredIncomingCallId = nil
                self.micPublishCallId = nil
                self.micPublishTask = nil
            }
        }
        self.room = nil
        self._callId = nil
        self.lastRoomName = nil
        self.lastIdentity = nil
        self.state = .idle
    }

    public func currentCallId() -> String? { return _callId }

    /// [2026-10-08 call-video-fix] The peer cancelled/ended a call we were
    /// still only RINGING for (never answered here). The ring-window
    /// preconnect Room (CallViewController.preconnectRoom) has no VC to tear
    /// it down, so it stayed joined to the SFU as a zombie: SFU log
    /// call_1791487864001 — caller cancelled at 19:31:05, the iPhone stayed in
    /// the room alone for 42 s, then auto-REJOINED (19:32:05→19:32:41) while
    /// the next call was already up — two Rooms fighting over the shared
    /// LKRTCAudioSession, and the new call's screen died 2 s after the zombie
    /// dropped. Disconnect + clear it. MAIN THREAD. No-op if the call was
    /// answered on this device (the CallViewController owns that teardown) or
    /// the singleton already points at another call.
    public func teardownUnansweredPreconnect(callId: String, reason: String) {
        guard !callId.isEmpty, let r = room, let active = _callId, active == callId else { return }
        guard answeredIncomingCallId != callId else { return }
        nativeCallDiag("preconnect_teardown", callId, "reason=\(reason) state=\(state.rawValue)")
        clear()
        Task { await r.disconnect() }
    }

    // [2026-10-08 call-connect-fast] See `answeredIncomingCallId` docs.
    /// Called from the CXAnswer handlers (stub + module) BEFORE/around
    /// action.fulfill(). Safe from any thread.
    public func markIncomingAnswered(callId: String) {
        guard !callId.isEmpty else { return }
        if !Thread.isMainThread {
            DispatchQueue.main.async { self.markIncomingAnswered(callId: callId) }
            return
        }
        answeredIncomingCallId = callId
        let pre = isPreconnected(callId: callId)
        nativeCallDiag("fast_answer_armed", callId, "preconnected=\(pre) state=\(state.rawValue)")
        if answeredAudioObserver == nil {
            answeredAudioObserver = NotificationCenter.default.addObserver(
                forName: Notification.Name("ExpoCallKitAudioSessionActivated"),
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self = self else { return }
                guard let cid = self.answeredIncomingCallId else { return }
                self.ensureIncomingMicPublished(callId: cid, reason: "didactivate")
            }
        }
        // Safety net: didActivate normally lands 100-500 ms after fulfill();
        // the old VC path published at ~1.5 s, so 1 s is never worse.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self else { return }
            guard self.answeredIncomingCallId == callId else { return }
            self.ensureIncomingMicPublished(callId: callId, reason: "answer_fallback_1s")
        }
    }

    /// Single-flight mic publish on the preconnected incoming Room. MAIN
    /// THREAD ONLY. Returns the shared Task (nil when there is no Room for
    /// `callId` — the caller then publishes on its own Room as before).
    @discardableResult
    public func ensureIncomingMicPublished(callId: String, reason: String) -> Task<LocalTrackPublication?, Never>? {
        guard let r = room, let active = _callId, active == callId else {
            return nil
        }
        if micPublishCallId == callId, let existing = micPublishTask {
            return existing
        }
        // [2026-10-09 p2p-ios] Ligação 1:1 de voz com P2P ligado: o P2P é dono
        // da mídia e NADA é publicado no LiveKit (Room fica em espera quente;
        // P2PCallBridge publica o mic se cair p/ o LiveKit). nil = quem chamou
        // também não publica (CallViewController checa P2PCallBridge.ownsMedia).
        if P2PCallBridge.startIfEligible(callId: callId, isCaller: false,
                                         hasVideo: P2PCallBridge.knownVideo(callId) ?? true) {
            nativeCallDiag("fast_mic_publish_skipped_p2p", callId, "reason=\(reason)")
            return nil
        }
        micPublishCallId = callId
        let t0 = Date()
        nativeCallDiag("fast_mic_publish_start", callId, "reason=\(reason) connected=\(r.connectionState == .connected)")
        let task = Task<LocalTrackPublication?, Never> {
            // A Room still finishing its ring-window connect throws
            // "Publisher is nil" on publish — wait (bounded) for .connected.
            var waitedMs = 0
            while r.connectionState != .connected && waitedMs < 10_000 {
                try? await Task.sleep(nanoseconds: 50_000_000)
                waitedMs += 50
            }
            do {
                let pub = try await r.localParticipant.setMicrophone(
                    enabled: true,
                    captureOptions: CallViewController.defaultAudioCaptureOptions()
                )
                let ms = Int(Date().timeIntervalSince(t0) * 1000)
                nativeCallDiag("fast_mic_published", callId, "reason=\(reason) ms=\(ms) waitedMs=\(waitedMs)")
                return pub
            } catch {
                nativeCallDiag("fast_mic_publish_failed", callId, "reason=\(reason) err=\(error)")
                // Let a later caller (CallViewController adopt path) retry.
                DispatchQueue.main.async {
                    if self.micPublishCallId == callId {
                        self.micPublishCallId = nil
                        self.micPublishTask = nil
                    }
                }
                return nil
            }
        }
        micPublishTask = task
        return task
    }

    /// [2026-10-09 p2p-ios] O mic desta ligação já começou a ser publicado no
    /// LiveKit (single-flight acima) → não troca de pilha p/ o P2P. MAIN THREAD.
    public func hasStartedIncomingMicPublish(callId: String) -> Bool {
        if Thread.isMainThread { return micPublishCallId == callId }
        return DispatchQueue.main.sync { micPublishCallId == callId }
    }

    // [2026-10-06 native-only outgoing] See `outgoingAnswerWatcher` docs.
    public func armOutgoingPublishOnAnswer(callId: String, hasVideo: Bool, micDesired: Bool) {
        guard let r = room, let active = _callId, active == callId else {
            print("[NativeCallRoom] armOutgoingPublishOnAnswer: no room for \(callId) — skip")
            return
        }
        if outgoingAnswerWatcher != nil { return }
        let w = OutgoingAnswerWatcher(callId: callId, hasVideo: hasVideo, micDesired: micDesired, room: r)
        outgoingAnswerWatcher = w
        r.add(delegate: w)
        w.installAnsweredObserver()
        nativeCallDiag("outgoing_answer_watcher_armed", callId, "video=\(hasVideo) mic=\(micDesired)")
    }

    private func disarmOutgoingAnswerWatcher() {
        guard let w = outgoingAnswerWatcher else { return }
        outgoingAnswerWatcher = nil
        w.tearDown()
    }

    // --- Listener registration (called from adoptNativeRoom) ------------------

    @objc public func addListener(_ listener: AnyObject) {
        listeners.add(listener)
    }
    @objc public func removeListener(_ listener: AnyObject) {
        listeners.remove(listener)
    }

    private func broadcast(_ event: NativeCallRoomEvent) {
        // NSHashTable allObjects is a snapshot — safe to iterate while
        // listeners come and go.
        for obj in listeners.allObjects {
            if let l = obj as? NativeCallRoomListener {
                l.nativeCallRoom(self, didEmit: event)
            }
        }
    }

    // --- RoomDelegate forwarders (called from CallViewController) -------------
    //
    // Each method here is invoked from the matching RoomDelegate callback in
    // CallViewController's `extension CallViewController: RoomDelegate` (so
    // CallViewController stays the sole RoomDelegate owner — clean separation
    // of concerns; we just receive forwarded fanout events).

    public func didConnect() {
        // localParticipant.identity is finalized at this point.
        let identity = room?.localParticipant.identity?.stringValue ?? lastIdentity ?? ""
        self.lastIdentity = identity
        self.state = .connected
        broadcast(.connected(roomName: lastRoomName ?? "", localIdentity: identity))
    }

    public func didDisconnect(reason: String?) {
        self.state = .disconnected
        broadcast(.disconnected(reason: reason ?? "unknown"))
    }

    public func participantConnected(identity: String, name: String? = nil) {
        broadcast(.participantConnected(identity: identity, name: name))
    }

    public func participantDisconnected(identity: String) {
        broadcast(.participantDisconnected(identity: identity))
    }

    public func trackSubscribed(participantId: String, trackSid: String, kind: String) {
        broadcast(.trackSubscribed(participantIdentity: participantId,
                                   trackSid: trackSid,
                                   kind: kind))
    }

    public func trackUnsubscribed(participantId: String, trackSid: String, kind: String) {
        broadcast(.trackUnsubscribed(participantIdentity: participantId,
                                     trackSid: trackSid,
                                     kind: kind))
    }

    public func connectionQualityChanged(identity: String, quality: String) {
        broadcast(.connectionQualityChanged(participantIdentity: identity,
                                            quality: quality))
    }

    // --- Snapshot API (called from adoptNativeRoom) ---------------------------

    public struct Snapshot {
        public let connected: Bool
        public let roomName: String?
        public let localIdentity: String?
        public let participants: [Any]
        public let connectionQuality: String
        public init(connected: Bool = false,
                    roomName: String? = nil,
                    localIdentity: String? = nil,
                    participants: [Any] = [],
                    connectionQuality: String = "unknown") {
            self.connected = connected
            self.roomName = roomName
            self.localIdentity = localIdentity
            self.participants = participants
            self.connectionQuality = connectionQuality
        }
        public func toDictionary() -> [String: Any] {
            return [
                "connected": connected,
                "roomName": roomName as Any,
                "localIdentity": localIdentity as Any,
                "participants": participants,
                "connectionQuality": connectionQuality,
            ]
        }
    }

    public func getSnapshot() -> Snapshot {
        // [FIX 2026-05-20 #954 regression] If a Room object exists at all (even
        // mid-connect), return a snapshot so JS can adopt it and wait via the
        // onLkConnected listener instead of racing a second Room.connect.
        // Previously this returned `Snapshot()` for any non-`.connected` state,
        // which made the JS `adoptNativeRoom` gate reject the room and fall
        // through to its own Room.connect → duplicate identity → SFU evicts
        // one → audio fight ("atende mas não toca audio").
        guard let r = room else { return Snapshot() }
        let isConnected = (r.connectionState == .connected)
        var participantsArr: [[String: Any]] = []
        for (_, p) in r.remoteParticipants {
            participantsArr.append([
                "identity": p.identity?.stringValue ?? "",
                "name": p.name ?? "",
                "isSpeaking": p.isSpeaking,
            ])
        }
        return Snapshot(
            connected: isConnected,
            roomName: lastRoomName,
            localIdentity: r.localParticipant.identity?.stringValue,
            participants: participantsArr,
            connectionQuality: "unknown"
        )
    }

    /// True if a Room object exists, regardless of connection state. JS uses
    /// this to decide whether to adopt the native room or spawn its own.
    public func hasRoom() -> Bool { return room != nil }

    /// [STAGE-A 2026-05-20] GAP #2 pre-connect check. Returns true when the
    /// current Room was published for the given callId AND is at least
    /// `.connecting`. The CXAnswer path uses this to skip a duplicate
    /// Room.connect when the push receive path already kicked one off during
    /// the ring window.
    public func isPreconnected(callId: String) -> Bool {
        guard room != nil else { return false }
        if let active = _callId, !active.isEmpty, active != callId { return false }
        return state == .connecting || state == .connected
    }

    /// [STAGE-A 2026-05-20] GAP #2 — Expose the underlying Room so the
    /// CallViewController adopt path can attach itself as RoomDelegate the
    /// moment it mounts. Without this, the preconnect Room (created with
    /// delegate=nil during the ring window) would miss participant /
    /// track-subscribed events.
    public func currentRoom() -> Room? { return room }

    /// [STAGE-A 2026-05-20] GAP #2 — Bind a RoomDelegate to the preconnected
    /// Room. Idempotent: LiveKit's `Room.add(delegate:)` is a multicast set.
    public func attachDelegate(_ delegate: RoomDelegate) {
        guard let r = room else { return }
        r.add(delegate: delegate)
    }

    // --- JS-facing operations (called from ExpoCallKitModule) ----------------

    /// Legacy entry kept so `lkConnect` in ExpoCallKitModule still compiles.
    /// Real connect path is via CallViewController; this is now a no-op log
    /// so JS can stop calling it without a native rebuild churn.
    public func connect(url: String, token: String, identity: String, roomName: String) {
        print("[NativeCallRoom] connect() called externally — ignored. Room is owned by CallViewController (room=\(roomName), identity=\(identity)).")
    }

    public func disconnect() {
        guard let r = room else {
            print("[NativeCallRoom] disconnect: no room to disconnect")
            return
        }
        Task { await r.disconnect() }
    }

    public func setMicEnabled(_ enabled: Bool) {
        // [2026-10-09 p2p-ios] P2P dono da mídia → toggle na track P2P.
        if let cid = _callId, P2PCallBridge.ownsMedia(cid) {
            P2PCallBridge.setMicEnabled(callId: cid, enabled)
            return
        }
        guard let r = room else {
            print("[NativeCallRoom] setMicEnabled(\(enabled)): no room")
            return
        }
        Task {
            do {
                // [WAVE 44B, 2026-05-21 gap A7] Pin captureOptions on every
                // mic toggle so an un-mute after a mute doesn't re-publish
                // a fresh track without AEC/AGC/NS. LK 2.5+ keeps the same
                // LocalAudioTrack across enabled toggles only when the track
                // exists — if it was disposed (e.g. user denied mic, then
                // re-granted) the next setMicrophone(true) creates a new
                // track that needs the DSP pin from the start.
                // [HD voice 2026-06-29 — iOS DEFERRED] The 48k+red/dtx publish
                // options were reverted: the pinned LiveKitClient (~> 2.0) pod's
                // AudioPublishOptions/AudioEncoding API couldn't be compile-
                // verified here (no Mac, no Actions log), and an unverified Swift
                // change blocks the iOS archive. iOS LiveKit already defaults
                // red+dtx ON for audio publishing, so 1:1 keeps loss-resilient
                // voice; only the explicit 48k bump is deferred until it can be
                // compiled on the Mac. Android got the full HD-voice tuning
                // (compiled local). Back to the known-good call.
                _ = try await r.localParticipant.setMicrophone(
                    enabled: enabled,
                    captureOptions: AudioCaptureOptions()
                )
            } catch {
                print("[NativeCallRoom] setMicEnabled(\(enabled)) failed: \(error)")
            }
        }
    }

    public func setCameraEnabled(_ enabled: Bool) {
        guard let r = room else {
            print("[NativeCallRoom] setCameraEnabled(\(enabled)): no room")
            return
        }
        Task {
            do {
                if enabled {
                    // [video-quality 2026-10-06] ONE source of truth: the same
                    // profile ladder + publish options CallViewController uses
                    // (network-aware 1080p/720p/540p, H.264 single encoding,
                    // balanced degradation). The literal copy that lived here
                    // drifted from the VC twice (VP9→H264, simulcast) — never
                    // duplicate the numbers again.
                    let captureOpts = CallViewController.defaultCameraCaptureOptions()
                    let publishOpts = CallViewController.defaultVideoPublishOptions()
                    _ = try await r.localParticipant.setCamera(
                        enabled: true,
                        captureOptions: captureOpts,
                        publishOptions: publishOpts
                    )
                    print("[NativeCallRoom] camera published profile=\(CallViewController.CallVideoQuality.current.rawValue) net=\(CallViewController.CallNetworkSnapshot.shared.label)")
                } else {
                    _ = try await r.localParticipant.setCamera(enabled: false)
                }
            } catch {
                print("[NativeCallRoom] setCameraEnabled(\(enabled)) failed: \(error)")
            }
        }
    }
}

/// [2026-10-06 native-only outgoing] Publishes the caller's mic (+camera) on
/// the shared outgoing Room once the callee really answered, for the case
/// where the owning CallViewController was dismissed early by an old JS
/// bundle (legacy adopt + dismissNativeCallVC flow). Mirrors
/// CallViewController.openOutgoingMicGate triggers:
///   * `CallKitCallAnsweredRemote` (CallSignalWs receiver loop), or
///   * the first remote track we subscribe (callee publishes nothing during
///     the ring, so this is genuine post-answer media-truth).
/// Idempotent — fires once. Lifetime: owned by NativeCallRoom until clear().
final class OutgoingAnswerWatcher: NSObject, RoomDelegate {
    private let callId: String
    private let hasVideo: Bool
    private let micDesired: Bool
    private weak var room: Room?
    private var fired = false
    private var answeredObserver: NSObjectProtocol?

    init(callId: String, hasVideo: Bool, micDesired: Bool, room: Room) {
        self.callId = callId
        self.hasVideo = hasVideo
        self.micDesired = micDesired
        self.room = room
        super.init()
    }

    func installAnsweredObserver() {
        guard answeredObserver == nil else { return }
        answeredObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("CallKitCallAnsweredRemote"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            let nid = (note.userInfo?["callId"] as? String)
                ?? (note.userInfo?["call_id"] as? String)
                ?? ""
            if !nid.isEmpty, nid != self.callId { return }
            self.publishOnAnswer(reason: "ws_call_accepted")
        }
    }

    func tearDown() {
        if let o = answeredObserver {
            NotificationCenter.default.removeObserver(o)
            answeredObserver = nil
        }
        // No explicit Room.remove(delegate:) — LiveKit's MulticastDelegate holds
        // delegates weakly, so dropping this object (NativeCallRoom.clear())
        // unregisters it. Avoids depending on an API the pinned pod may rename.
        room = nil
    }

    private func publishOnAnswer(reason: String) {
        guard !fired, let r = room else { return }
        // [2026-10-09 p2p-ios] P2P dono da mídia → não publica no LiveKit.
        if P2PCallBridge.ownsMedia(callId) { return }
        fired = true
        nativeCallDiag("outgoing_mic_gate_open_watcher", callId, reason)
        let wantMic = micDesired
        let wantCam = hasVideo
        Task {
            if wantMic {
                do {
                    _ = try await r.localParticipant.setMicrophone(
                        enabled: true,
                        captureOptions: AudioCaptureOptions()
                    )
                    print("[OutgoingAnswerWatcher] mic published on answer (\(reason)) callId=\(self.callId)")
                } catch {
                    print("[OutgoingAnswerWatcher] mic publish failed: \(error)")
                    nativeCallDiag("outgoing_watcher_mic_failed", self.callId, "\(error)")
                }
            }
            if wantCam {
                // Same publish options as the JS-driven camera toggle.
                NativeCallRoom.shared.setCameraEnabled(true)
            }
        }
    }

    // MARK: RoomDelegate (only the one hook we need; the rest keep defaults)

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        DispatchQueue.main.async { [weak self] in
            self?.publishOnAnswer(reason: "remote_track_subscribed")
        }
    }
}

/// NativeCallTokenFetcher — real fetcher used by the native CallKit answer
/// path (ProviderDelegate in ExpoCallKitModule + the cold-start
/// VoipPushAppDelegateSubscriber stub). When CXAnswerCallAction fires we
/// cannot rely on the RN JS bridge being alive, so this Swift class talks to
/// `/api/email.php?action=chat_livekit_token` directly and returns the LK
/// `token` + `url` so CallViewController can present and connect Room in
/// <500ms.
///
/// Inputs are read from the App Group UserDefaults (suite
/// `group.com.onemundo.mail`):
///   - `auth_token` — Bearer token (persisted by `persistAuthForNativeCall`)
///   - `api_base`   — e.g. `https://chatyy.com.br` (same key)
///
/// JSON body matches the JS-side `chatLivekitToken(conversationId, room)`:
///   `{ "action": "chat_livekit_token", "room": "<roomName>" }`
/// The backend accepts either `conversation_id` (int) or `room` (string).
/// Because CallKit's UUID-keyed answer path only knows the server-side
/// callId / room override (the push's `room_name`/`conversation_id`/`call_id`
/// string), we always send `room`. Backend identity is the authenticated
/// user (server-side from session), not whatever we pass; we forward
/// `identity` + `role` anyway so future server-side enforcement can match.
public class NativeCallTokenFetcher {
    public struct TokenResult {
        public let token: String
        public let url: String
        // [2026-10-09 native-transport] iceServers do chat_livekit_token
        // (TURN regional + credencial de 1h). Vazio = usa os do LiveKit.
        public var iceServers: [IceServer] = []
    }
    public static let shared = NativeCallTokenFetcher()

    // [2026-10-09 native-transport] iceServers por token LiveKit. O token
    // passa por vários caminhos (preconnect do VoIP, cache, apresentação do
    // CallViewController) só como String — indexar pelo próprio token evita
    // mudar todas essas assinaturas. Tokens que vieram do JS não estão aqui →
    // connect() segue sem ConnectOptions (comportamento antigo).
    private static let iceLock = NSLock()
    private static var iceByToken: [String: [IceServer]] = [:]
    private static var iceOrder: [String] = []

    static func rememberIceServers(_ ice: [IceServer], forToken token: String) {
        guard !ice.isEmpty, !token.isEmpty else { return }
        iceLock.lock(); defer { iceLock.unlock() }
        if iceByToken[token] == nil { iceOrder.append(token) }
        iceByToken[token] = ice
        while iceOrder.count > 8 {
            let old = iceOrder.removeFirst()
            iceByToken.removeValue(forKey: old)
        }
    }

    public static func iceServers(forToken token: String) -> [IceServer] {
        iceLock.lock(); defer { iceLock.unlock() }
        return iceByToken[token] ?? []
    }

    /// ConnectOptions com os iceServers do token, ou nil (→ connect sem options,
    /// idêntico ao comportamento anterior).
    public static func connectOptions(forToken token: String) -> ConnectOptions? {
        let ice = iceServers(forToken: token)
        if ice.isEmpty { return nil }
        return ConnectOptions(iceServers: ice, iceTransportPolicy: .all)
    }

    /// Lê `iceServers` do envelope ({urls: String|[String], username?, credential?}).
    static func parseIceServers(_ raw: Any?) -> [IceServer] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        var out: [IceServer] = []
        for s in arr {
            var urls: [String] = []
            if let u = s["urls"] as? String { urls = [u] }
            else if let us = s["urls"] as? [Any] { urls = us.compactMap { $0 as? String } }
            urls = urls.filter { !$0.isEmpty }
            if urls.isEmpty { continue }
            let user = (s["username"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let cred = (s["credential"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            out.append(IceServer(urls: urls, username: user, credential: cred))
        }
        return out
    }

    /// [STAGE-A 2026-05-20] GAP #7 — MD5 hex helper for the per-device
    /// identity suffix. CryptoKit's Insecure.MD5 is fine here: we only
    /// need a stable, short, low-collision hash (not a security primitive).
    fileprivate static func md5Hex(_ s: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    enum FetchError: Error, LocalizedError {
        case missingAppGroup
        case missingAuth
        case badURL(String)
        case httpStatus(Int, String)
        case malformedResponse(String)

        var errorDescription: String? {
            switch self {
            case .missingAppGroup: return "App Group UserDefaults unavailable"
            case .missingAuth:     return "Missing auth_token or api_base in App Group"
            case .badURL(let s):   return "Bad URL: \(s)"
            case .httpStatus(let c, let b): return "HTTP \(c): \(b.prefix(200))"
            case .malformedResponse(let b): return "Malformed response body: \(b.prefix(200))"
            }
        }
    }

    public func fetchToken(roomName: String, identity: String, role: String) async throws -> TokenResult {
        // [CALL-TRACE 2026-05-20 WAVE42] Step 7/12 — iOS mints LK token.
        let __ct_t0 = Date().timeIntervalSince1970 * 1000
        NSLog("[CallTrace][7/12] LkTokenFetcher.fetchToken room=\(roomName) role=\(role) identity=\(identity) ts=\(Int(__ct_t0))")
        guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else {
            NSLog("[CallTrace][7b/12] LkTokenFetcher result success=false err=missingAppGroup elapsedMs=\(Int(Date().timeIntervalSince1970 * 1000 - __ct_t0))")
            throw FetchError.missingAppGroup
        }
        guard let authToken = ud.string(forKey: "auth_token"), !authToken.isEmpty,
              let apiBase = ud.string(forKey: "api_base"), !apiBase.isEmpty else {
            NSLog("[CallTrace][7b/12] LkTokenFetcher result success=false err=missingAuth elapsedMs=\(Int(Date().timeIntervalSince1970 * 1000 - __ct_t0))")
            throw FetchError.missingAuth
        }

        // The JS `apiCall` builds URLs as `<API_URL>?action=<action>` where
        // API_URL == `<BASE_URL>/api/email.php`. The native side persists
        // BASE_URL (e.g. `https://chatyy.com.br`) into `api_base`, so we
        // append the rest here. Strip any trailing slash to be safe.
        let baseTrimmed = apiBase.hasSuffix("/") ? String(apiBase.dropLast()) : apiBase
        let urlString = "\(baseTrimmed)/api/email.php?action=chat_livekit_token"
        guard let url = URL(string: urlString) else {
            throw FetchError.badURL(urlString)
        }

        var req = URLRequest(url: url, timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        // [STAGE-A 2026-05-20] GAP #7 — Per-device identity. Mint a stable
        // 8-char device hash from identifierForVendor + callId (MD5) and
        // suffix it onto the identity so each physical device joining the
        // same room gets a unique LiveKit identity. Without this, phone+
        // tablet+laptop on the same account all join with identity=email and
        // the SFU evicts the older participant ("connected from another
        // device"). Server still authorizes via the bearer token; identity
        // is purely a routing key inside LiveKit.
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        let raw = "\(deviceId):\(roomName)"
        let md5Hex = Self.md5Hex(raw)
        let deviceHash = String(md5Hex.prefix(8))
        let deviceIdentity = identity.isEmpty ? deviceHash : "\(identity)#\(deviceHash)"

        // Mirror the JS body shape (apiCall POST puts the action into the
        // body too, so server-side $input always has it). `identity` and
        // `role` are accepted-but-ignored today; included for forward compat.
        let body: [String: Any] = [
            "action": "chat_livekit_token",
            "room": roomName,
            "identity": deviceIdentity,
            "role": role,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw FetchError.malformedResponse("non-HTTP response")
        }
        let bodyStr = String(data: data, encoding: .utf8) ?? ""
        guard (200..<300).contains(http.statusCode) else {
            throw FetchError.httpStatus(http.statusCode, bodyStr)
        }

        // Response shape from chat.php: { success: true, data: { token, url, room, identity, expires_at, iceServers } }
        // Tolerate either top-level token/url (legacy callers) or nested
        // under `data`.
        let json = try JSONSerialization.jsonObject(with: data, options: [])
        guard let root = json as? [String: Any] else {
            throw FetchError.malformedResponse(bodyStr)
        }
        let envelope: [String: Any] = (root["data"] as? [String: Any]) ?? root
        guard let token = envelope["token"] as? String, !token.isEmpty else {
            throw FetchError.malformedResponse(bodyStr)
        }
        let lkUrl = (envelope["url"] as? String)
            ?? (envelope["livekit_url"] as? String)
            ?? ""
        guard !lkUrl.isEmpty else {
            NSLog("[CallTrace][7b/12] LkTokenFetcher result success=false err=emptyUrl elapsedMs=\(Int(Date().timeIntervalSince1970 * 1000 - __ct_t0))")
            throw FetchError.malformedResponse(bodyStr)
        }
        let ice = Self.parseIceServers(envelope["iceServers"])
        Self.rememberIceServers(ice, forToken: token)
        // [2026-10-09 p2p-ios] `p2p` do servidor (flag da ligação 1:1 P2P).
        P2PCallBridge.rememberConfig(envelope["p2p"], iceServers: envelope["iceServers"], callId: roomName)
        NSLog("[CallTrace][7b/12] LkTokenFetcher result success=true url=\(lkUrl) ice=\(ice.count) elapsedMs=\(Int(Date().timeIntervalSince1970 * 1000 - __ct_t0))")
        return TokenResult(token: token, url: lkUrl, iceServers: ice)
    }
}
