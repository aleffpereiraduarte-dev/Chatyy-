// Stage #995 — full native SwiftUI UI, replaces JS /call.js on mobile + Stage #993 PiP wired
//
// GroupCallViewController.swift — UIKit host for the SwiftUI GroupCallView.
// Mirrors the 1:1 CallViewController pattern: Room owner, RoomDelegate,
// SwiftUI hosted via UIHostingController, hangup posts a NotificationCenter
// event the JS module observes. The state object is GroupCallSessionState —
// a participants array instead of a single remote video track, plus the
// audio/video toggle flags the SwiftUI controls bind to.
//
// Module entrypoints:
//   ExpoCallKit.openGroupCall(roomName, lkUrl, lkToken, JSON, hasVideo)   (legacy)
//   ExpoCallKit.openNativeGroupCall({ roomName, lkUrl, lkToken, iceServers,
//       conversationId, title, hasVideo, isOutgoing, participants })      (2026-10-09)
//   CallViewController.present(... isOutgoing:false) → presentIncoming(...)
//       when the answered CallKit call is a GROUP call and the native group
//       UI flag (App Group `chatyy_native_group_call_ui`) is on.
//
// [2026-10-09 native-group-call] WhatsApp-level native group call:
//   * incoming (CallKit answer) adopts the ring-window preconnected Room
//     (NativeCallRoom) — no 2nd Room / duplicate identity — and ends the
//     CallKit call on hangup (CXEndCallAction);
//   * leaving NEVER sends call_end (a group call continues for the others);
//   * reconnect: LK's own ICE/resume first ("Reconectando…"); if the Room
//     still drops, up to 2 rejoins with a FRESH token before giving up;
//   * shared data contract with /call.js + /livekit-room.html (topic
//     `chatyy.call`, JSON reaction / raise_hand / lower_hand) — legacy
//     `R:` / `H:` frames still parsed;
//   * add participant = native contact picker (CallParticipantPickerView →
//     chat_call_add), same as the 1:1 screen;
//   * minimize keeps the call alive (static holder) + tap-to-restore bar;
//   * active speakers are pulled to the top of big grids; tap a tile to pin
//     it in spotlight (big tile + filmstrip);
//   * CallKit system mute button mirrored onto the mic.

import UIKit
import SwiftUI
import LiveKitClient
import AVFoundation
import Combine
import CallKit

/// Thread-safe flags read from non-main contexts (ProviderDelegate's
/// dismissActiveCallSurfaces, RoomDelegate callbacks).
final class GroupCallFlags: @unchecked Sendable {
    private let lock = NSLock()
    private var _didHangup = false
    private var _liveRemotes = 0
    var didHangup: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _didHangup }
        set { lock.lock(); _didHangup = newValue; lock.unlock() }
    }
    var liveRemotes: Int {
        get { lock.lock(); defer { lock.unlock() }; return _liveRemotes }
        set { lock.lock(); _liveRemotes = newValue; lock.unlock() }
    }
}

// [Wave B/C forward-fix 2026-05-19] `@unchecked Sendable` — LK Swift 2.5+
// RoomDelegate conform requires Sendable. Same rationale as CallViewController.
final class GroupCallViewController: UIViewController, @unchecked Sendable {

    static let groupCallEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // MARK: - Native-UI routing flag (set from JS, read by the answer path)

    static let kAppGroup = "group.com.onemundo.mail"
    static let kNativeGroupUiKey = "chatyy_native_group_call_ui"
    /// LiveKit data topic shared with /call.js and /livekit-room.html.
    static let kDataTopic = "chatyy.call"
    /// Contract version reported to JS (`supportsNativeGroupCallUI`).
    static let kNativeGroupUiVersion = 1

    static var nativeGroupUiEnabled: Bool {
        return UserDefaults(suiteName: kAppGroup)?.bool(forKey: kNativeGroupUiKey) ?? false
    }

    static func setNativeGroupUiEnabled(_ on: Bool) {
        UserDefaults(suiteName: kAppGroup)?.set(on, forKey: kNativeGroupUiKey)
    }

    /// The pushed payload for `callId` (App Group pending VoIP queue), if any.
    static func pendingPayload(callId: String) -> [String: Any]? {
        guard let ud = UserDefaults(suiteName: kAppGroup),
              let queue = ud.array(forKey: "pendingVoipCall") as? [[String: Any]] else { return nil }
        for entry in queue where (entry["callId"] as? String) == callId {
            return entry["payload"] as? [String: Any]
        }
        return nil
    }

    /// True when `callId` is a GROUP call: backend group rooms are named
    /// `group_<conversationId>`; pushes also carry is_group / conversation_type.
    static func isGroupCall(callId: String) -> Bool {
        if callId.hasPrefix("group_") { return true }
        guard let p = pendingPayload(callId: callId) else { return false }
        if let s = p["is_group"] as? String, s == "1" || s.lowercased() == "true" { return true }
        if let b = p["is_group"] as? Bool, b { return true }
        if let n = p["is_group"] as? NSNumber, n.intValue == 1 { return true }
        if let t = p["conversation_type"] as? String, t == "group" { return true }
        return false
    }

    /// Incoming answer routing gate (CallViewController.present).
    static func shouldPresentNativeGroup(callId: String) -> Bool {
        return nativeGroupUiEnabled && isGroupCall(callId: callId)
    }

    /// Strong holder while a group call is alive (minimize keeps the Room).
    static var activeInstance: GroupCallViewController?

    // MARK: - Instance

    let roomName: String
    private(set) var lkUrl: String
    private(set) var lkToken: String
    let hasVideo: Bool
    let isOutgoing: Bool
    let conversationId: String
    let displayTitle: String
    let flags = GroupCallFlags()

    private var initialRoster: [GroupParticipant]
    private var room: Room?
    private let session: GroupCallSessionState
    /// Room adopted from NativeCallRoom (CallKit ring-window preconnect).
    private var adoptedPreconnect = false
    private var isMinimizing = false
    private var rejoinAttempts = 0
    /// A rejoin is already scheduled (connect error + didDisconnect can both
    /// report the same failure).
    private var rejoinPending = false
    private var noAnswerTimer: Timer?
    private var systemMuteObserver: NSObjectProtocol?
    private let callStartedAt = Date()
    /// identity → last time LiveKit reported them speaking (main only).
    private var lastSpokeAt: [String: Date] = [:]
    private var lastReorderAt = Date.distantPast
    /// bare email (lowercased) → display name from the JS roster.
    private var rosterNames: [String: String] = [:]

    init(roomName: String,
         lkUrl: String,
         lkToken: String,
         hasVideo: Bool,
         initialRoster: [GroupParticipant],
         isOutgoing: Bool = true,
         conversationId: String = "",
         title: String = "") {
        self.roomName = roomName
        self.lkUrl = lkUrl
        self.lkToken = lkToken
        self.hasVideo = hasVideo
        self.initialRoster = initialRoster
        self.isOutgoing = isOutgoing
        // group_<cid> → cid when JS didn't pass one (incoming path).
        if !conversationId.isEmpty {
            self.conversationId = conversationId
        } else if roomName.hasPrefix("group_") {
            self.conversationId = String(roomName.dropFirst("group_".count))
        } else {
            self.conversationId = ""
        }
        self.displayTitle = title.isEmpty ? "Chamada em grupo" : title
        self.session = GroupCallSessionState(
            participants: initialRoster,
            status: "Conectando\u{2026}",
            micEnabled: true,
            camEnabled: hasVideo,
            speakerOn: true
        )
        super.init(nibName: nil, bundle: nil)
        for p in initialRoster {
            let bare = GroupCallViewController.bareEmail(p.identity)
            if !bare.isEmpty && p.name != p.identity { rosterNames[bare] = p.name }
        }
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported for GroupCallViewController")
    }

    static func bareEmail(_ identity: String) -> String {
        let base = identity.split(separator: "#").first.map(String.init) ?? identity
        return base.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private func displayName(identity: String, name: String?) -> String {
        if let n = name, !n.isEmpty, n != identity, !n.contains("#") { return n }
        let bare = GroupCallViewController.bareEmail(identity)
        if let n = rosterNames[bare], !n.isEmpty { return n }
        let local = bare.split(separator: "@").first.map(String.init) ?? bare
        return local.isEmpty ? identity : local
    }

    /// Read from ProviderDelegate.dismissActiveCallSurfaces: a WS `call_end`
    /// relayed for a group room must not kick us out while others are still
    /// in the call (leaving a group call never ends it for everyone).
    nonisolated var shouldIgnoreRemoteCallEnd: Bool {
        return !flags.didHangup && flags.liveRemotes > 0
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let rootView = GroupCallView(
            session: session,
            roomName: displayTitle,
            hasVideo: hasVideo,
            onHangup: { [weak self] in self?.handleHangup(reason: "user_hangup") },
            onToggleMute: { [weak self] desired in self?.applyMicEnabled(desired) },
            onToggleCam: { [weak self] desired in self?.applyCamEnabled(desired) },
            onToggleSpeaker: { [weak self] desired in self?.applySpeaker(desired) },
            onSwitchCamera: { [weak self] in self?.switchCamera() },
            onScreenShare: { [weak self] in self?.toggleScreenShare() },
            onAddMember: { [weak self] in self?.handleAddMember() },
            onMinimize: { [weak self] in self?.minimize() },
            onSendReaction: { [weak self] emoji in self?.sendReaction(emoji) },
            onHandRaiseToggle: { [weak self] raised in self?.publishHandRaise(raised) },
            onTogglePin: { [weak self] identity in self?.togglePin(identity) }
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

        installSystemMuteObserver()

        // [2026-10-09 native-group-call] Incoming CallKit answer: adopt the
        // ring-window preconnected Room instead of joining a 2nd time with
        // the same identity (SFU would evict one of them).
        if !isOutgoing, NativeCallRoom.shared.isPreconnected(callId: roomName),
           let pre = NativeCallRoom.shared.currentRoom() {
            adoptPreconnectedRoom(pre)
            return
        }

        if ExpoCallKitModule.sharedCallKitUUID(forCallId: roomName) == nil {
            // Not a CallKit call (JS-launched: outgoing / chip / link /
            // scheduled) → we own the AVAudioSession (BT/wired wins).
            AudioRouter.shared.configureForCall(hasVideo: hasVideo)
        }
        self.session.speakerOn = AudioRouter.shared.speakerOn

        if !lkUrl.isEmpty, !lkToken.isEmpty {
            connectFresh(url: lkUrl, token: lkToken)
        } else {
            fetchTokenAndConnect()
        }
        if isOutgoing { armNoAnswerTimer() }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Dismissed by someone else (CXEndCallAction from the lock screen /
        // system pill, stale-surface sweep) without our hangup → tear down.
        if !isMinimizing && !flags.didHangup && (isBeingDismissed || presentingViewController == nil) {
            handleHangup(reason: "dismissed", alreadyDismissed: true)
        }
    }

    // MARK: - Connect

    private func makeRoomOptions() -> RoomOptions {
        // [Wave C] adaptiveStream + dynacast: each tile subscribes to the
        // layer it actually renders (small tiles → low), dynacast pauses
        // layers nobody consumes — the data/battery saver for big groups.
        return RoomOptions(
            defaultCameraCaptureOptions: CallViewController.defaultCameraCaptureOptions(isGroup: true),
            // [2026-10-06 screen-share iOS] Broadcast extension when bundled,
            // in-app capture otherwise — see ScreenShareSupport.swift.
            defaultScreenShareCaptureOptions: ScreenShareSupport.captureOptions(),
            defaultAudioCaptureOptions: CallViewController.defaultAudioCaptureOptions(),
            defaultVideoPublishOptions: CallViewController.defaultVideoPublishOptions(profile: .group540),
            adaptiveStream: true,
            dynacast: true
        )
    }

    private func connectFresh(url: String, token: String) {
        print("[GroupCallVC] connecting — room=\(roomName) url=\(url)")
        let r = Room(delegate: self, roomOptions: makeRoomOptions())
        self.room = r
        let wantMic = session.micEnabled
        let wantCam = hasVideo && session.camEnabled
        Task { [weak self] in
            guard let self = self else { return }
            do {
                try await r.connect(url: url, token: token, connectOptions: NativeCallTokenFetcher.connectOptions(forToken: token))
                // [Wave B audio] Pin AudioCaptureOptions (AEC+AGC+NS).
                try await r.localParticipant.setMicrophone(
                    enabled: wantMic,
                    captureOptions: CallViewController.defaultAudioCaptureOptions()
                )
                print("[GroupCallVC] mic published (aec+agc+ns) — room=\(self.roomName)")
                if wantCam {
                    await self.publishCamera(on: r)
                }
                await MainActor.run { self.seedExistingParticipants(r) }
            } catch {
                print("[GroupCallVC] connect/mic failed: \(error)")
                await MainActor.run { self.handleConnectFailure() }
            }
        }
    }

    private func publishCamera(on r: Room) async {
        let captureOpts = CallViewController.defaultCameraCaptureOptions(position: currentCameraPosition, profile: .group540)
        let publishOpts = CallViewController.defaultVideoPublishOptions(profile: .group540)
        if let pub = try? await r.localParticipant.setCamera(
            enabled: true,
            captureOptions: captureOpts,
            publishOptions: publishOpts
        ), let track = pub.track as? LocalVideoTrack {
            await MainActor.run { self.updateLocalParticipant(videoTrack: track) }
            print("[GroupCallVC] camera published (profile=group540) — room=\(roomName)")
        }
    }

    private func fetchTokenAndConnect() {
        let identity: String = {
            if let ud = UserDefaults(suiteName: GroupCallViewController.kAppGroup),
               let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
            return roomName
        }()
        let room = roomName
        Task { [weak self] in
            var result: NativeCallTokenFetcher.TokenResult?
            for attempt in 1...3 {
                do {
                    result = try await NativeCallTokenFetcher.shared.fetchToken(roomName: room, identity: identity, role: "publisher")
                    break
                } catch {
                    print("[GroupCallVC] token fetch \(attempt)/3 failed: \(error)")
                    if attempt < 3 { try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000) }
                }
            }
            let fetched = result
            await MainActor.run {
                guard let self = self, !self.flags.didHangup else { return }
                if let res = fetched {
                    self.lkUrl = res.url
                    self.lkToken = res.token
                    self.connectFresh(url: res.url, token: res.token)
                } else {
                    self.session.status = "Sem conexão"
                    self.handleConnectFailure()
                }
            }
        }
    }

    private func adoptPreconnectedRoom(_ pre: Room) {
        print("[GroupCallVC] adopting preconnected Room — room=\(roomName)")
        adoptedPreconnect = true
        self.room = pre
        pre.add(delegate: self)
        self.session.speakerOn = AudioRouter.shared.speakerOn
        // Mic publish joins the single-flight task the CXAnswer path armed.
        _ = NativeCallRoom.shared.ensureIncomingMicPublished(callId: roomName, reason: "group_adopt")
        if pre.connectionState == .connected {
            session.status = "Conectado"
            flags.liveRemotes = pre.remoteParticipants.count
        }
        seedExistingParticipants(pre)
        updateLocalParticipant()
        if hasVideo {
            Task { [weak self] in await self?.publishCamera(on: pre) }
        }
    }

    /// Room already had people in it (we joined late / adopted a preconnect):
    /// LiveKit won't replay participantDidConnect for them.
    @MainActor
    private func seedExistingParticipants(_ r: Room) {
        for p in r.remoteParticipants.values {
            let identity = p.identity?.stringValue ?? ""
            if identity.isEmpty { continue }
            let videoPub = p.videoTracks.first(where: { $0.source == .camera }) ?? p.videoTracks.first
            let vt = (videoPub?.isMuted == false) ? (videoPub?.track as? VideoTrack) : nil
            let audioMuted = p.audioTracks.first?.isMuted ?? false
            upsertRemote(identity: identity,
                         name: displayName(identity: identity, name: p.name),
                         videoTrack: vt,
                         clearVideo: vt == nil,
                         audioMuted: audioMuted)
        }
        flags.liveRemotes = r.remoteParticipants.count
        if !r.remoteParticipants.isEmpty { cancelNoAnswerTimer() }
    }

    @MainActor
    private func handleConnectFailure() {
        guard !flags.didHangup, !rejoinPending else { return }
        if rejoinAttempts < 2 {
            rejoinAttempts += 1
            rejoinPending = true
            session.status = "Reconectando\u{2026}"
            let delay = Double(rejoinAttempts) * 1.2
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                self.rejoinPending = false
                guard !self.flags.didHangup else { return }
                if let old = self.room {
                    self.room = nil
                    old.remove(delegate: self)
                    Task { await old.disconnect() }
                }
                if self.adoptedPreconnect {
                    NativeCallRoom.shared.clear()
                    self.adoptedPreconnect = false
                }
                // Fresh token: the old one may be expired / bound to a
                // dead identity slot.
                self.fetchTokenAndConnect()
            }
        } else {
            session.status = "Falha na conexão"
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.handleHangup(reason: "connect_failed")
            }
        }
    }

    // MARK: - No-answer (outgoing only)

    private func armNoAnswerTimer() {
        noAnswerTimer?.invalidate()
        noAnswerTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.flags.liveRemotes == 0 && !self.flags.didHangup {
                self.session.status = "Ninguém atendeu"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    self?.handleHangup(reason: "no_answer")
                }
            }
        }
    }

    private func cancelNoAnswerTimer() {
        noAnswerTimer?.invalidate()
        noAnswerTimer = nil
    }

    // MARK: - Actions

    private func handleHangup(reason: String, alreadyDismissed: Bool = false) {
        if flags.didHangup {
            if !alreadyDismissed { dismiss(animated: true, completion: nil) }
            return
        }
        flags.didHangup = true
        nativeCallDiag("group_hangup", roomName, "reason=\(reason)")
        // Resolve the CallKit UUID BEFORE posting the ended notification (its
        // module observer clears the callId→UUID map).
        let callKitUUID = ExpoCallKitModule.sharedCallKitUUID(forCallId: roomName)
        cancelNoAnswerTimer()
        if let tok = systemMuteObserver {
            NotificationCenter.default.removeObserver(tok)
            systemMuteObserver = nil
        }
        OngoingCallBarOverlayController.shared.uninstall()
        // [Wave B audio] Clear AVAudioSession route override + listener.
        AudioRouter.shared.teardown()
        // Leaving a group call must NOT send call_end (the call continues for
        // everyone else). JS (services/nativeGroupCall) closes our own
        // history row on onCallEnded.
        NotificationCenter.default.post(
            name: GroupCallViewController.groupCallEndedNotification,
            object: nil,
            userInfo: ["callId": roomName, "reason": reason, "group": true]
        )
        if let r = self.room {
            self.room = nil
            if adoptedPreconnect { NativeCallRoom.shared.clear() }
            // Same bounded-disconnect pattern as CallViewController (#583/#729).
            Task.detached(priority: .userInitiated) {
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { await r.disconnect() }
                    group.addTask { try? await Task.sleep(nanoseconds: 3_000_000_000) }
                    _ = await group.next()
                    group.cancelAll()
                }
            }
        }
        // End the CallKit call (incoming answered via CallKit). Outgoing
        // group calls launched from JS have no CallKit entry → no-op.
        if let uuid = callKitUUID {
            let controller = CXCallController(queue: .main)
            controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
                if let error = error {
                    print("[GroupCallVC] CXEndCallAction error: \(error.localizedDescription)")
                }
            }
        }
        if GroupCallViewController.activeInstance === self {
            GroupCallViewController.activeInstance = nil
        }
        if !alreadyDismissed {
            dismiss(animated: true, completion: nil)
        }
    }

    /// Minimize: keep the Room alive (static holder) and show the tap-to-
    /// restore bar on top of the app.
    private func minimize() {
        guard !flags.didHangup else { return }
        isMinimizing = true
        GroupCallViewController.activeInstance = self
        let title = displayTitle
        let video = hasVideo
        let started = callStartedAt
        dismiss(animated: true) { [weak self] in
            self?.isMinimizing = false
            OngoingCallBarOverlayController.shared.install(
                callerName: title,
                hasVideo: video,
                startedAt: started,
                onTapRestore: {
                    GroupCallViewController.restoreActive()
                }
            )
        }
    }

    static func restoreActive() {
        guard let vc = activeInstance, !vc.flags.didHangup else { return }
        guard vc.presentingViewController == nil, let root = resolvePresentingViewController() else { return }
        topMostViewController(from: root).present(vc, animated: true, completion: nil)
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
            if let nid = note.userInfo?["callId"] as? String, !nid.isEmpty, nid != self.roomName { return }
            self.session.micEnabled = !muted
            self.applyMicEnabled(!muted)
        }
    }

    private func applyMicEnabled(_ enabled: Bool) {
        guard let r = self.room else { return }
        Task { [weak self] in
            do {
                // [Wave B audio] Pin AudioCaptureOptions on every toggle.
                try await r.localParticipant.setMicrophone(
                    enabled: enabled,
                    captureOptions: CallViewController.defaultAudioCaptureOptions()
                )
                await MainActor.run { self?.updateLocalParticipant(audioMuted: !enabled) }
            } catch {
                print("[GroupCallVC] setMicrophone(\(enabled)) failed: \(error)")
                await MainActor.run { self?.session.micEnabled = !enabled }
            }
        }
    }

    private func applyCamEnabled(_ enabled: Bool) {
        guard let r = self.room else { return }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                if enabled, r.localParticipant.localVideoTracks.first(where: { $0.source == .camera }) == nil {
                    // First publish (audio call upgraded to video) — group profile.
                    await self.publishCamera(on: r)
                    return
                }
                let pub = try await r.localParticipant.setCamera(enabled: enabled)
                await MainActor.run {
                    if enabled {
                        self.updateLocalParticipant(videoTrack: pub?.track as? LocalVideoTrack)
                    } else {
                        self.updateLocalParticipant(clearVideo: true)
                    }
                }
            } catch {
                print("[GroupCallVC] setCamera(\(enabled)) failed: \(error)")
                await MainActor.run { self.session.camEnabled = !enabled }
            }
        }
    }

    /// [Wave B audio] Speaker toggle delegates to AudioRouter.
    private func applySpeaker(_ enabled: Bool) {
        let actual = AudioRouter.shared.setSpeaker(enabled)
        DispatchQueue.main.async { [weak self] in
            self?.session.speakerOn = actual
        }
    }

    private var currentCameraPosition: AVCaptureDevice.Position = .front
    private func switchCamera() {
        guard let r = self.room else { return }
        let next: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
        currentCameraPosition = next
        Task { [weak self] in
            guard let self = self else { return }
            // [2026-10-08 call-video-fix] Swap the device in place on the same
            // track via CameraCapturer (LK 2.0.18 ignores new options on an
            // already-published camera).
            if let lt = r.localParticipant.localVideoTracks.first(where: { $0.source == .camera })?.track as? LocalVideoTrack,
               let cap = lt.capturer as? CameraCapturer {
                do {
                    _ = try await cap.set(cameraPosition: next)
                    return
                } catch {
                    print("[GroupCallVC] in-place camera flip failed: \(error) — republish fallback")
                }
            }
            do {
                let opts = CallViewController.defaultCameraCaptureOptions(position: next, profile: .group540)
                let pub = try await r.localParticipant.setCamera(enabled: true, captureOptions: opts)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.updateLocalParticipant(videoTrack: track) }
                }
            } catch {
                print("[GroupCallVC] switchCamera failed: \(error) — fallback to disable/enable")
                _ = try? await r.localParticipant.setCamera(enabled: false)
                let pub = try? await r.localParticipant.setCamera(enabled: true)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.updateLocalParticipant(videoTrack: track) }
                }
            }
        }
    }

    private var screenSharing: Bool = false
    private var screenShareInFlight: Bool = false
    private var broadcastStopToken: ScreenShareSupport.ObserverToken?

    // [2026-10-06 screen-share iOS] Same mechanism as CallViewController.
    private func toggleScreenShare() {
        guard let r = self.room else { return }
        guard !screenShareInFlight else { return }
        let desired = !(ScreenShareSupport.isSharing(room: r) || screenSharing)
        screenShareInFlight = true
        if desired && ScreenShareSupport.useBroadcastExtension && broadcastStopToken == nil {
            broadcastStopToken = ScreenShareSupport.observeBroadcastStopped { [weak self] in
                guard let self = self, let r = self.room else { return }
                self.screenSharing = false
                Task { try? await ScreenShareSupport.set(room: r, enabled: false) }
            }
        }
        Task { [weak self] in
            guard let self = self else { return }
            do {
                try await ScreenShareSupport.set(room: r, enabled: desired)
                await MainActor.run {
                    self.screenShareInFlight = false
                    if !desired || !ScreenShareSupport.useBroadcastExtension {
                        self.screenSharing = desired
                    }
                }
            } catch {
                print("[GroupCallVC] set(.screenShareVideo, enabled: \(desired)) failed: \(error)")
                await MainActor.run {
                    self.screenShareInFlight = false
                    self.screenSharing = ScreenShareSupport.isSharing(room: r)
                }
            }
        }
    }

    func room(_ room: Room,
              participant: LocalParticipant,
              didPublishTrack publication: LocalTrackPublication) {
        guard publication.source == .screenShareVideo else { return }
        Task { @MainActor [weak self] in
            self?.screenShareInFlight = false
            self?.screenSharing = true
        }
    }

    func room(_ room: Room,
              participant: LocalParticipant,
              didUnpublishTrack publication: LocalTrackPublication) {
        guard publication.source == .screenShareVideo else { return }
        Task { @MainActor [weak self] in
            self?.screenShareInFlight = false
            self?.screenSharing = false
            if let tok = self?.broadcastStopToken {
                ScreenShareSupport.stopObserving(tok)
                self?.broadcastStopToken = nil
            }
        }
    }

    /// [2026-10-09 native-group-call] Native contact picker (same sheet as the
    /// 1:1 screen) → backend chat_call_add rings the contact INTO this room.
    private func handleAddMember() {
        var presentIds = Set<String>()
        if let r = self.room {
            for p in r.remoteParticipants.values {
                if let raw = p.identity?.stringValue, !raw.isEmpty {
                    presentIds.insert(GroupCallViewController.bareEmail(raw))
                }
            }
        }
        let picker = CallParticipantPickerView(
            callId: roomName,
            conversationId: conversationId,
            isVideo: hasVideo,
            alreadyInCall: presentIds,
            onDismiss: { [weak self] in
                self?.presentedViewController?.dismiss(animated: true)
            }
        )
        let host = UIHostingController(rootView: picker)
        if #available(iOS 15.0, *), let sheet = host.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(host, animated: true, completion: nil)
        // Keep the legacy notification for any JS listener.
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitNativeAddMember"),
            object: nil,
            userInfo: ["callId": roomName]
        )
    }

    // MARK: - Data contract (topic chatyy.call)

    private var myEmail: String {
        return UserDefaults(suiteName: GroupCallViewController.kAppGroup)?.string(forKey: "user_email")?.lowercased() ?? ""
    }

    private func publishJSON(_ obj: [String: Any]) {
        guard let r = self.room,
              let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        Task {
            do {
                try await r.localParticipant.publish(
                    data: data,
                    options: DataPublishOptions(topic: GroupCallViewController.kDataTopic, reliable: true)
                )
            } catch {
                print("[GroupCallVC] publish data failed: \(error)")
            }
        }
    }

    private func spawnReaction(_ emoji: String) {
        let reaction = CallFloatingReaction(
            id: UUID(),
            emoji: emoji.isEmpty ? "\u{1F389}" : String(emoji.prefix(16)),
            spawnedAt: Date(),
            xOffset: CGFloat.random(in: -80...80)
        )
        session.floatingReactions.append(reaction)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            self?.session.floatingReactions.removeAll { $0.id == reaction.id }
        }
    }

    /// Local burst + shared-contract publish so web / JS / native peers see it.
    private func sendReaction(_ emoji: String) {
        DispatchQueue.main.async { [weak self] in self?.spawnReaction(emoji) }
        let me = myEmail
        publishJSON([
            "type": "reaction",
            "emoji": emoji,
            "from_email": me,
            "name": me.split(separator: "@").first.map(String.init) ?? me,
            "call_id": roomName,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ])
    }

    private func publishHandRaise(_ raised: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.updateLocalParticipant(handRaised: raised)
        }
        let me = myEmail
        publishJSON([
            "type": raised ? "raise_hand" : "lower_hand",
            "email": me,
            "name": me.split(separator: "@").first.map(String.init) ?? me,
            "call_id": roomName,
        ])
    }

    // MARK: - Spotlight / ordering

    private func togglePin(_ identity: String) {
        // Spotlight only makes sense with 2+ remote tiles.
        guard session.participants.filter({ !$0.isLocal }).count >= 2 || session.pinnedIdentity != nil else { return }
        if session.pinnedIdentity == identity {
            session.pinnedIdentity = nil
        } else {
            session.pinnedIdentity = identity
        }
    }

    /// Big grids (> 9 remotes scroll): pull whoever spoke in the last 4 s to
    /// the top so the active speakers are always on screen. Throttled to
    /// 1.5 s so fast back-and-forth doesn't reshuffle the grid.
    @MainActor
    private func reorderBySpeakingIfNeeded() {
        let remotes = session.participants.filter { !$0.isLocal }
        guard remotes.count > 9 else { return }
        let now = Date()
        guard now.timeIntervalSince(lastReorderAt) > 1.5 else { return }
        let recent: (GroupParticipant) -> Bool = { p in
            if let t = self.lastSpokeAt[p.identity] { return now.timeIntervalSince(t) < 4 }
            return false
        }
        // Already all recent speakers within the first 6 tiles → leave it.
        let firstPage = Set(remotes.prefix(6).map { $0.identity })
        let needs = remotes.contains { recent($0) && !firstPage.contains($0.identity) }
        guard needs else { return }
        lastReorderAt = now
        let speakers = remotes.filter(recent)
        let others = remotes.filter { !recent($0) }
        let locals = session.participants.filter { $0.isLocal }
        session.participants = speakers + others + locals
    }

    // MARK: - Roster mutation helpers (main actor only)

    @MainActor
    private func updateLocalParticipant(videoTrack: LocalVideoTrack? = nil,
                                        clearVideo: Bool = false,
                                        audioMuted: Bool? = nil,
                                        handRaised: Bool? = nil,
                                        isSpeaking: Bool? = nil) {
        var arr = session.participants
        if let idx = arr.firstIndex(where: { $0.isLocal }) {
            let cur = arr[idx]
            arr[idx] = GroupParticipant(
                id: cur.id,
                identity: cur.identity,
                name: cur.name,
                videoTrack: clearVideo ? nil : (videoTrack ?? cur.videoTrack),
                audioMuted: audioMuted ?? cur.audioMuted,
                isLocal: true,
                isSpeaking: isSpeaking ?? cur.isSpeaking,
                handRaised: handRaised ?? cur.handRaised,
                connectionQuality: cur.connectionQuality
            )
        } else {
            let identity = room?.localParticipant.identity?.stringValue ?? "local"
            arr.append(GroupParticipant(
                id: "local:" + identity,
                identity: identity,
                name: "Você",
                videoTrack: clearVideo ? nil : videoTrack,
                audioMuted: audioMuted ?? !session.micEnabled,
                isLocal: true,
                isSpeaking: isSpeaking ?? false,
                handRaised: handRaised ?? false,
                connectionQuality: 3
            ))
        }
        session.participants = arr
    }

    @MainActor
    private func upsertRemote(identity: String,
                              name: String? = nil,
                              videoTrack: VideoTrack? = nil,
                              clearVideo: Bool = false,
                              audioMuted: Bool? = nil,
                              isSpeaking: Bool? = nil,
                              handRaised: Bool? = nil,
                              connectionQuality: Int? = nil) {
        var arr = session.participants
        // Roster placeholders are keyed by bare email; LiveKit identities are
        // "<email>#<device>" → match either form, then adopt the LK identity.
        let bare = GroupCallViewController.bareEmail(identity)
        let idx = arr.firstIndex(where: { !$0.isLocal && $0.identity == identity })
            ?? arr.firstIndex(where: { !$0.isLocal && $0.identity == bare })
        if let idx = idx {
            let cur = arr[idx]
            arr[idx] = GroupParticipant(
                id: cur.id,
                identity: identity,
                name: name ?? cur.name,
                // [2026-10-08 call-video-fix] clearVideo drops a frozen frame.
                videoTrack: clearVideo ? nil : (videoTrack ?? cur.videoTrack),
                audioMuted: audioMuted ?? cur.audioMuted,
                isLocal: false,
                isSpeaking: isSpeaking ?? cur.isSpeaking,
                handRaised: handRaised ?? cur.handRaised,
                connectionQuality: connectionQuality ?? cur.connectionQuality
            )
        } else {
            arr.append(GroupParticipant(
                id: "remote:" + identity,
                identity: identity,
                name: name ?? displayName(identity: identity, name: nil),
                videoTrack: videoTrack,
                audioMuted: audioMuted ?? false,
                isLocal: false,
                isSpeaking: isSpeaking ?? false,
                handRaised: handRaised ?? false,
                connectionQuality: connectionQuality ?? 3
            ))
        }
        session.participants = arr
    }

    @MainActor
    private func removeRemote(identity: String) {
        session.participants.removeAll { $0.identity == identity && !$0.isLocal }
        if session.pinnedIdentity == identity { session.pinnedIdentity = nil }
        lastSpokeAt.removeValue(forKey: identity)
    }

    @MainActor
    private func applyRemoteHand(fromIdentity: String?, email: String?, raised: Bool) {
        let key = GroupCallViewController.bareEmail(fromIdentity ?? email ?? "")
        guard !key.isEmpty else { return }
        if let p = session.participants.first(where: { !$0.isLocal && GroupCallViewController.bareEmail($0.identity) == key }) {
            upsertRemote(identity: p.identity, handRaised: raised)
        }
    }

    deinit {
        // [2026-10-06 screen-share iOS] Darwin observer holds an unretained token.
        if let tok = broadcastStopToken { ScreenShareSupport.stopObserving(tok) }
        if let tok = systemMuteObserver { NotificationCenter.default.removeObserver(tok) }
        noAnswerTimer?.invalidate()
        if let r = self.room { Task { await r.disconnect() } }
    }

    // MARK: - Presentation helpers

    /// Legacy entry (openGroupCall): JS-launched, outgoing semantics.
    static func present(from base: UIViewController,
                        roomName: String,
                        lkUrl: String,
                        lkToken: String,
                        participantsJson: String,
                        hasVideo: Bool) {
        present(from: base, roomName: roomName, lkUrl: lkUrl, lkToken: lkToken,
                participantsJson: participantsJson, hasVideo: hasVideo,
                isOutgoing: true, conversationId: "", title: "")
    }

    static func present(from base: UIViewController,
                        roomName: String,
                        lkUrl: String,
                        lkToken: String,
                        participantsJson: String,
                        hasVideo: Bool,
                        isOutgoing: Bool,
                        conversationId: String,
                        title: String) {
        // Same room already on screen / minimized → just bring it back.
        if let existing = activeInstance, existing.roomName == roomName, !existing.flags.didHangup {
            OngoingCallBarOverlayController.shared.uninstall()
            restoreActive()
            return
        }
        if let onScreen = existingGroupVC(from: base), onScreen.roomName == roomName {
            print("[GroupCallVC.present] already presenting room=\(roomName) — skip")
            return
        }
        let roster = decodeRoster(participantsJson)
        let top = topMostViewController(from: base)
        let vc = GroupCallViewController(
            roomName: roomName,
            lkUrl: lkUrl,
            lkToken: lkToken,
            hasVideo: hasVideo,
            initialRoster: roster,
            isOutgoing: isOutgoing,
            conversationId: conversationId,
            title: title
        )
        activeInstance = vc
        nativeCallDiag("group_present", roomName, "outgoing=\(isOutgoing) video=\(hasVideo) roster=\(roster.count)")
        top.present(vc, animated: true, completion: nil)
    }

    /// CallKit-answered group call (CallViewController.present reroutes here).
    static func presentIncoming(from base: UIViewController,
                                callId: String,
                                hasVideo: Bool,
                                lkUrl: String,
                                lkToken: String,
                                conversationId: String) {
        let payload = pendingPayload(callId: callId)
        let title = (payload?["group_name"] as? String)
            ?? (payload?["conversation_name"] as? String)
            ?? ""
        present(from: base, roomName: callId, lkUrl: lkUrl, lkToken: lkToken,
                participantsJson: "[]", hasVideo: hasVideo,
                isOutgoing: false, conversationId: conversationId, title: title)
    }

    private static func decodeRoster(_ json: String) -> [GroupParticipant] {
        guard let data = json.data(using: .utf8) else { return [] }
        guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            print("[GroupCallVC] decodeRoster: invalid JSON")
            return []
        }
        let me = UserDefaults(suiteName: kAppGroup)?.string(forKey: "user_email")?.lowercased() ?? ""
        return raw.compactMap { entry -> GroupParticipant? in
            let identityRaw = (entry["identity"] as? String) ?? (entry["email"] as? String) ?? ""
            let identity = bareEmail(identityRaw)
            guard !identity.isEmpty, identity != me else { return nil }
            let name = (entry["name"] as? String) ?? identity
            let audioMuted = (entry["audioMuted"] as? Bool) ?? false
            return GroupParticipant(
                id: "remote:" + identity,
                identity: identity,
                name: name.isEmpty ? identity : name,
                videoTrack: nil,
                audioMuted: audioMuted,
                isLocal: false,
                isSpeaking: false,
                handRaised: false,
                connectionQuality: 3
            )
        }
    }

    static func topMostViewController(from base: UIViewController) -> UIViewController {
        var top: UIViewController = base
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    private static func existingGroupVC(from base: UIViewController) -> GroupCallViewController? {
        var node: UIViewController? = base
        while let cur = node {
            if let g = cur as? GroupCallViewController, !cur.isBeingDismissed { return g }
            node = cur.presentedViewController
        }
        return nil
    }
}

// MARK: - RoomDelegate

extension GroupCallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[GroupCallVC] roomDidConnect — room=\(roomName)")
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            self.session.status = "Conectado"
            self.rejoinAttempts = 0
            self.updateLocalParticipant()
        }
    }

    func roomIsReconnecting(_ room: Room) {
        Task { @MainActor [weak self] in
            self?.session.status = "Reconectando\u{2026}"
        }
    }

    func roomDidReconnect(_ room: Room) {
        Task { @MainActor [weak self] in
            self?.session.status = "Conectado"
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[GroupCallVC] didDisconnectWithError — error=\(String(describing: error))")
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            // Our own hangup, or a stale Room we already replaced.
            guard !self.flags.didHangup, self.room === room else { return }
            if error != nil {
                // Network / SFU drop that LiveKit's resume couldn't save →
                // rejoin with a fresh token (bounded).
                self.handleConnectFailure()
            } else {
                self.handleHangup(reason: "room_closed")
            }
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        let name = participant.name
        let count = room.remoteParticipants.count
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            self.flags.liveRemotes = count
            self.cancelNoAnswerTimer()
            self.upsertRemote(identity: identity, name: self.displayName(identity: identity, name: name))
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        let count = room.remoteParticipants.count
        Task { @MainActor [weak self] in
            self?.flags.liveRemotes = count
            self?.removeRemote(identity: identity)
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        // Screen share wins the tile only when there's no camera (keeps the
        // face visible; a dedicated screen tile is a follow-up).
        if publication.source == .screenShareVideo,
           participant.videoTracks.contains(where: { $0.source == .camera && !$0.isMuted && $0.track != nil }) {
            return
        }
        guard let track = publication.track as? VideoTrack else { return }
        let identity = participant.identity?.stringValue ?? "?"
        // [2026-10-08 call-video-fix] Arrived muted (camera off) → avatar.
        let muted = publication.isMuted
        Task { @MainActor [weak self] in
            if muted {
                self?.upsertRemote(identity: identity, clearVideo: true)
            } else {
                self?.upsertRemote(identity: identity, videoTrack: track)
            }
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        let identity = participant.identity?.stringValue ?? "?"
        // Fall back to another live video of the same person (camera ↔ screen).
        let other = participant.videoTracks.first(where: {
            $0.sid != publication.sid && !$0.isMuted && $0.track != nil
        })?.track as? VideoTrack
        Task { @MainActor [weak self] in
            if let o = other {
                self?.upsertRemote(identity: identity, videoTrack: o)
            } else {
                self?.upsertRemote(identity: identity, clearVideo: true)
            }
        }
    }

    func room(_ room: Room,
              participant: Participant,
              trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
        // [2026-10-08 call-video-fix] Remote CAMERA off/on (mute, no
        // unsubscribe): swap the tile to the avatar and back.
        if trackPublication.kind == .video {
            guard (participant as? RemoteParticipant) != nil else { return }
            let identity = participant.identity?.stringValue ?? "?"
            let track = trackPublication.track as? VideoTrack
            Task { @MainActor [weak self] in
                if isMuted || track == nil {
                    self?.upsertRemote(identity: identity, clearVideo: true)
                } else {
                    self?.upsertRemote(identity: identity, videoTrack: track)
                }
            }
            return
        }
        guard trackPublication.kind == .audio else { return }
        let identity = participant.identity?.stringValue ?? "?"
        let isLocal = (participant as? LocalParticipant) != nil
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if isLocal {
                self.updateLocalParticipant(audioMuted: isMuted)
            } else {
                self.upsertRemote(identity: identity, audioMuted: isMuted)
            }
        }
    }

    /// Active speakers — per-tile ring + big-grid reordering.
    func room(_ room: Room, didUpdateSpeakingParticipants speakers: [Participant]) {
        let speakingIds = Set(speakers.compactMap { $0.identity?.stringValue })
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            let now = Date()
            for id in speakingIds { self.lastSpokeAt[id] = now }
            self.session.participants = self.session.participants.map { p in
                let speaking = speakingIds.contains(p.identity)
                if p.isSpeaking == speaking { return p }
                return GroupParticipant(
                    id: p.id,
                    identity: p.identity,
                    name: p.name,
                    videoTrack: p.videoTrack,
                    audioMuted: p.audioMuted,
                    isLocal: p.isLocal,
                    isSpeaking: speaking,
                    handRaised: p.handRaised,
                    connectionQuality: p.connectionQuality
                )
            }
            if let dominant = speakers.first(where: { !($0 is LocalParticipant) })?.identity?.stringValue {
                self.session.dominantSpeaker = dominant
            }
            self.reorderBySpeakingIfNeeded()
        }
    }

    func room(_ room: Room,
              participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        let score: Int
        switch quality {
        case .excellent: score = 3
        case .good:      score = 2
        case .poor:      score = 1
        default:         score = 0
        }
        let identity = participant.identity?.stringValue ?? "?"
        let isLocal = (participant as? LocalParticipant) != nil
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if isLocal {
                self.session.connectionQuality = score
            } else {
                self.upsertRemote(identity: identity, connectionQuality: score)
            }
        }
    }

    /// Shared contract (topic chatyy.call JSON) + legacy `R:` / `H:` frames.
    func room(_ room: Room,
              participant: RemoteParticipant?,
              didReceiveData data: Data,
              forTopic topic: String) {
        guard let str = String(data: data, encoding: .utf8) else { return }
        let fromIdentity = participant?.identity?.stringValue
        if str.hasPrefix("R:") {
            let emoji = String(str.dropFirst(2))
            Task { @MainActor [weak self] in self?.spawnReaction(emoji) }
            return
        }
        if str.hasPrefix("H:") {
            let raised = (str == "H:1")
            Task { @MainActor [weak self] in
                self?.applyRemoteHand(fromIdentity: fromIdentity, email: nil, raised: raised)
            }
            return
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "reaction":
            guard let emoji = obj["emoji"] as? String, !emoji.isEmpty else { return }
            Task { @MainActor [weak self] in self?.spawnReaction(emoji) }
        case "raise_hand", "lower_hand":
            let email = obj["email"] as? String
            Task { @MainActor [weak self] in
                self?.applyRemoteHand(fromIdentity: fromIdentity, email: email, raised: type == "raise_hand")
            }
        case "hand_raise":
            let raised = (obj["raised"] as? Bool) ?? ((obj["raised"] as? NSNumber)?.boolValue ?? false)
            Task { @MainActor [weak self] in
                self?.applyRemoteHand(fromIdentity: fromIdentity, email: nil, raised: raised)
            }
        default:
            break
        }
    }
}
