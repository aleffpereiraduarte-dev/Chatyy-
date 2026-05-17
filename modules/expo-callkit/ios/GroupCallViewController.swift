// Stage #995 — full native SwiftUI UI, replaces JS /call.js on mobile + Stage #993 PiP wired
//
// GroupCallViewController.swift — UIKit host for the SwiftUI GroupCallView.
// Mirrors the 1:1 CallViewController pattern: Room owner, RoomDelegate,
// SwiftUI hosted via UIHostingController, hangup posts a NotificationCenter
// event the JS module observes. The state object is GroupCallSessionState —
// a participants array instead of a single remote video track, plus the
// audio/video toggle flags the SwiftUI controls bind to.
//
// Roster handoff: JS passes the initial participants as a JSON-encoded string
// (mirroring Android's intent extras). We seed the SwiftUI grid with avatar
// placeholders right away; LiveKit's RoomDelegate callbacks (participantDidConnect,
// didSubscribeTrack, didUpdateSpeakingParticipants, didUpdateConnectionQuality,
// didUpdateIsMuted) reconcile against the participant snapshot as media arrives.
//
// Module entrypoint:
//   ExpoCallKit.openGroupCall(roomName, lkUrl, lkToken,
//                             JSON.stringify(participants), hasVideo)
// → ExpoCallKitModule resolves the rootViewController and calls
//   GroupCallViewController.present(from:roomName:...).

import UIKit
import SwiftUI
import LiveKitClient
import AVFoundation
import Combine

final class GroupCallViewController: UIViewController {

    static let groupCallEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    let roomName: String
    let lkUrl: String
    let lkToken: String
    let hasVideo: Bool

    private let initialRoster: [GroupParticipant]
    private var room: Room?
    private let session: GroupCallSessionState

    init(roomName: String,
         lkUrl: String,
         lkToken: String,
         hasVideo: Bool,
         initialRoster: [GroupParticipant]) {
        self.roomName = roomName
        self.lkUrl = lkUrl
        self.lkToken = lkToken
        self.hasVideo = hasVideo
        self.initialRoster = initialRoster
        self.session = GroupCallSessionState(
            participants: initialRoster,
            status: "Conectando\u{2026}",
            micEnabled: true,
            camEnabled: hasVideo,
            speakerOn: true
        )
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported for GroupCallViewController")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        let rootView = GroupCallView(
            session: session,
            roomName: roomName,
            hasVideo: hasVideo,
            onHangup: { [weak self] in self?.handleHangup() },
            onToggleMute: { [weak self] desired in self?.applyMicEnabled(desired) },
            onToggleCam: { [weak self] desired in self?.applyCamEnabled(desired) },
            onToggleSpeaker: { [weak self] desired in self?.applySpeaker(desired) },
            onSwitchCamera: { [weak self] in self?.switchCamera() },
            onScreenShare: { [weak self] in self?.toggleScreenShare() },
            onAddMember: { [weak self] in self?.handleAddMember() },
            onMinimize: { [weak self] in self?.dismiss(animated: true) },
            onSendReaction: { [weak self] emoji in self?.sendReaction(emoji) },
            onHandRaiseToggle: { [weak self] raised in self?.publishHandRaise(raised) }
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

        guard !lkUrl.isEmpty, !lkToken.isEmpty else {
            print("[GroupCallVC] missing lkUrl/lkToken — staying in placeholder grid")
            return
        }
        print("[GroupCallVC] connecting — room=\(roomName) url=\(lkUrl)")
        let r = Room(delegate: self)
        self.room = r
        Task { [weak self] in
            guard let self = self else { return }
            do {
                try await r.connect(url: self.lkUrl, token: self.lkToken)
                try await r.localParticipant.setMicrophone(enabled: true)
                print("[GroupCallVC] mic published — room=\(self.roomName)")
                if self.hasVideo {
                    if let pub = try? await r.localParticipant.setCamera(enabled: true),
                       let track = pub.track as? LocalVideoTrack {
                        await MainActor.run {
                            self.updateLocalParticipant(videoTrack: track)
                        }
                        print("[GroupCallVC] camera published — room=\(self.roomName)")
                    }
                }
            } catch {
                print("[GroupCallVC] connect/mic failed: \(error)")
                await MainActor.run { self.session.status = "Erro" }
            }
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - Actions

    private func handleHangup() {
        NotificationCenter.default.post(
            name: GroupCallViewController.groupCallEndedNotification,
            object: nil,
            userInfo: ["callId": roomName]
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
                try await r.localParticipant.setMicrophone(enabled: enabled)
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
                let pub = try await r.localParticipant.setCamera(enabled: enabled)
                await MainActor.run {
                    if enabled {
                        self.updateLocalParticipant(videoTrack: pub?.track as? LocalVideoTrack)
                    } else {
                        self.updateLocalParticipant(videoTrack: nil)
                    }
                }
            } catch {
                print("[GroupCallVC] setCamera(\(enabled)) failed: \(error)")
                await MainActor.run { self.session.camEnabled = !enabled }
            }
        }
    }

    private func applySpeaker(_ enabled: Bool) {
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.overrideOutputAudioPort(enabled ? .speaker : .none)
        } catch {
            print("[GroupCallVC] setSpeaker failed: \(error)")
        }
    }

    private var currentCameraPosition: AVCaptureDevice.Position = .front
    private func switchCamera() {
        guard let r = self.room else { return }
        let next: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
        currentCameraPosition = next
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let opts = CameraCaptureOptions(position: next)
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
    private func toggleScreenShare() {
        guard let r = self.room else { return }
        let desired = !screenSharing
        screenSharing = desired
        Task {
            do {
                _ = try await r.localParticipant.setScreenShareEnabled(desired)
            } catch {
                print("[GroupCallVC] setScreenShareEnabled(\(desired)) failed: \(error)")
                self.screenSharing = !desired
            }
        }
    }

    private func handleAddMember() {
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitNativeAddMember"),
            object: nil,
            userInfo: ["callId": roomName]
        )
    }

    /// Local floating-reaction + LiveKit data channel publish so other peers
    /// also see the burst. Mirrors CallViewController.sendReaction.
    private func sendReaction(_ emoji: String) {
        let reaction = CallFloatingReaction(
            id: UUID(),
            emoji: emoji.isEmpty ? "🎉" : emoji,
            spawnedAt: Date(),
            xOffset: CGFloat.random(in: -80...80)
        )
        DispatchQueue.main.async {
            self.session.floatingReactions.append(reaction)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                self?.session.floatingReactions.removeAll { $0.id == reaction.id }
            }
        }
        guard let r = self.room else { return }
        let payload = "R:" + emoji
        guard let data = payload.data(using: .utf8) else { return }
        Task {
            do {
                try await r.localParticipant.publish(data: data)
            } catch {
                print("[GroupCallVC] publish reaction failed: \(error)")
            }
        }
    }

    /// Hand-raise — broadcast through the data channel so other clients can
    /// flip the per-tile yellow hand badge. Local user also gets the badge
    /// via updateLocalParticipant.
    private func publishHandRaise(_ raised: Bool) {
        DispatchQueue.main.async {
            self.updateLocalParticipant(handRaised: raised)
        }
        guard let r = self.room else { return }
        let payload = raised ? "H:1" : "H:0"
        guard let data = payload.data(using: .utf8) else { return }
        Task {
            do {
                try await r.localParticipant.publish(data: data)
            } catch {
                print("[GroupCallVC] publish hand-raise failed: \(error)")
            }
        }
    }

    // MARK: - Roster mutation helpers (main actor only)

    @MainActor
    private func updateLocalParticipant(videoTrack: LocalVideoTrack? = nil,
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
                videoTrack: videoTrack ?? cur.videoTrack,
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
                videoTrack: videoTrack,
                audioMuted: audioMuted ?? false,
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
                              audioMuted: Bool? = nil,
                              isSpeaking: Bool? = nil,
                              handRaised: Bool? = nil,
                              connectionQuality: Int? = nil) {
        var arr = session.participants
        if let idx = arr.firstIndex(where: { $0.identity == identity && !$0.isLocal }) {
            let cur = arr[idx]
            arr[idx] = GroupParticipant(
                id: cur.id,
                identity: cur.identity,
                name: name ?? cur.name,
                videoTrack: videoTrack ?? cur.videoTrack,
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
                name: name ?? identity,
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
    }

    deinit {
        if let r = self.room { Task { await r.disconnect() } }
    }

    // MARK: - Presentation helper

    static func present(from base: UIViewController,
                        roomName: String,
                        lkUrl: String,
                        lkToken: String,
                        participantsJson: String,
                        hasVideo: Bool) {
        let roster = decodeRoster(participantsJson)
        let top = topMostViewController(from: base)
        let vc = GroupCallViewController(
            roomName: roomName,
            lkUrl: lkUrl,
            lkToken: lkToken,
            hasVideo: hasVideo,
            initialRoster: roster
        )
        top.present(vc, animated: true, completion: nil)
    }

    private static func decodeRoster(_ json: String) -> [GroupParticipant] {
        guard let data = json.data(using: .utf8) else { return [] }
        guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            print("[GroupCallVC] decodeRoster: invalid JSON")
            return []
        }
        return raw.compactMap { entry -> GroupParticipant? in
            guard let identity = entry["identity"] as? String, !identity.isEmpty else { return nil }
            let name = (entry["name"] as? String) ?? identity
            let audioMuted = (entry["audioMuted"] as? Bool) ?? false
            return GroupParticipant(
                id: "remote:" + identity,
                identity: identity,
                name: name,
                videoTrack: nil,
                audioMuted: audioMuted,
                isLocal: false,
                isSpeaking: false,
                handRaised: false,
                connectionQuality: 3
            )
        }
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

extension GroupCallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[GroupCallVC] roomDidConnect — room=\(roomName)")
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "Conectado"
            self?.updateLocalParticipant()
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[GroupCallVC] didDisconnectWithError — error=\(String(describing: error))")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            NotificationCenter.default.post(
                name: GroupCallViewController.groupCallEndedNotification,
                object: nil,
                userInfo: ["callId": self.roomName]
            )
            self.dismiss(animated: true, completion: nil)
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        let name = participant.name
        let displayName = (name?.isEmpty == false ? name : identity) ?? identity
        Task { @MainActor [weak self] in
            self?.upsertRemote(identity: identity, name: displayName)
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        Task { @MainActor [weak self] in
            self?.removeRemote(identity: identity)
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else { return }
        let identity = participant.identity?.stringValue ?? "?"
        Task { @MainActor [weak self] in
            self?.upsertRemote(identity: identity, videoTrack: track)
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        let identity = participant.identity?.stringValue ?? "?"
        Task { @MainActor [weak self] in
            self?.upsertRemote(identity: identity, videoTrack: nil)
        }
    }

    func room(_ room: Room,
              participant: Participant,
              trackPublication: TrackPublication,
              didUpdateIsMuted isMuted: Bool) {
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

    /// Active speakers — flip per-tile green outline. LiveKit gives us the
    /// list of currently-active participants on every audio-energy snapshot.
    func room(_ room: Room, didUpdateSpeakingParticipants speakers: [Participant]) {
        let speakingIds = Set(speakers.compactMap { $0.identity?.stringValue })
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            // Rebuild participants array with new isSpeaking flag per row.
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
        }
    }

    /// Connection quality per participant — we want it on every tile that has
    /// a value below "excellent" so the SwiftUI tile draws the quality bars.
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

    /// Data channel messages (`R:<emoji>` reactions, `H:1`/`H:0` hand toggles).
    /// Filter strictly so a future control message can ride the same channel
    /// without us mis-handling it.
    func room(_ room: Room,
              participant: RemoteParticipant?,
              didReceiveData data: Data,
              forTopic topic: String?) {
        guard let str = String(data: data, encoding: .utf8) else { return }
        if str.hasPrefix("R:") {
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
        } else if str.hasPrefix("H:") {
            let raised = (str == "H:1")
            let identity = participant?.identity?.stringValue ?? "?"
            Task { @MainActor [weak self] in
                self?.upsertRemote(identity: identity, handRaised: raised)
            }
        }
    }
}
