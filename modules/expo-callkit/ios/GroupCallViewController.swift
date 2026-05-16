import UIKit
import SwiftUI
import LiveKit

// [native group call screen, 2026-05-16]
//
// UIKit host for the SwiftUI GroupCallView. Mirrors the 1:1 CallViewController
// pattern (Room owner, RoomDelegate, SwiftUI hosted via UIHostingController,
// hangup posts a NotificationCenter event the JS module observes), but the
// state object is GroupCallSessionState — a participants array instead of a
// single remote video track.
//
// Roster handoff: JS passes the initial participants as a JSON-encoded
// string (mirroring Android's intent extras). We parse it once in init so
// the SwiftUI grid renders avatar placeholders immediately — actual video
// tracks come in later via RoomDelegate's didSubscribeTrack callback.
//
// Module entrypoint:
//   ExpoCallKit.openGroupCall(roomName, lkUrl, lkToken,
//                             JSON.stringify(participants), hasVideo)
// → ExpoCallKitModule resolves the rootViewController and calls
//   GroupCallViewController.present(from:roomName:...).

final class GroupCallViewController: UIViewController {

    /// Posted when the user hangs up via the native UI. ExpoCallKitModule
    /// observes this in its OnCreate flow and re-emits as `onCallEnded` so
    /// JS can clean up (clear /group-call route, drop bearer, etc.).
    /// Reuses the existing 1:1 callEndedNotification name so the module's
    /// observer covers both screens with one wire — the userInfo's `callId`
    /// is the room name for group calls.
    static let groupCallEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // Connect descriptor — captured at present() time. roomName doubles as
    // the JS-side call_id when we post the ended notification.
    let roomName: String
    let lkUrl: String
    let lkToken: String
    let hasVideo: Bool

    // Initial roster decoded from the JSON string the module passes in. Only
    // used to seed the SwiftUI grid with placeholder avatars; once LiveKit
    // fires participantDidConnect we overwrite from the room's snapshot.
    private let initialRoster: [GroupParticipant]

    // The LiveKit room. Held as a var so we can release explicitly on hangup
    // / didDisconnectWithError, same pattern as CallViewController.
    private var room: Room?

    // Source of truth for the SwiftUI view. All mutations happen on the main
    // actor — the RoomDelegate callbacks below dispatch via MainActor.run.
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
            camEnabled: hasVideo
        )
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        // Match the 1:1 screen — only the explicit red hangup button ends
        // the call. Swipe-to-dismiss would skip our room.disconnect path.
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported for GroupCallViewController")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        // Build the SwiftUI tree. Closures forward control taps to the VC
        // so the Room mutations stay on the UIKit side.
        let rootView = GroupCallView(
            session: session,
            hasVideo: hasVideo,
            onHangup: { [weak self] in
                self?.handleHangup()
            },
            onToggleMute: { [weak self] desired in
                self?.applyMicEnabled(desired)
            },
            onToggleCam: { [weak self] desired in
                self?.applyCamEnabled(desired)
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

        // Kick the LiveKit connect — same Room(delegate:) init the 1:1
        // CallViewController uses on Day 2. Mic publishes immediately, camera
        // only for video calls. The connect Task captures `r` strongly so the
        // suspend chain survives even if `self.room` is nilled on hangup.
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
                await MainActor.run {
                    self.session.status = "Erro"
                }
            }
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }

    // MARK: - Hangup

    private func handleHangup() {
        // Post BEFORE dismiss so the module observer always sees the end
        // event regardless of when the dismissal animation completes.
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
                await MainActor.run {
                    self?.updateLocalParticipant(audioMuted: !enabled)
                }
            } catch {
                print("[GroupCallVC] setMicrophone(\(enabled)) failed: \(error)")
                await MainActor.run {
                    self?.session.micEnabled = !enabled
                }
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
                await MainActor.run {
                    self.session.camEnabled = !enabled
                }
            }
        }
    }

    // MARK: - Roster mutation helpers (main actor only)

    /// Replace the local participant's snapshot in the session. Used after
    /// setCamera publishes a track and when the mic toggles. Creates the
    /// local entry on first use so audio-only group calls still render the
    /// local mic state badge (even though we hide the PiP tile when no
    /// videoTrack is available).
    @MainActor
    private func updateLocalParticipant(videoTrack: LocalVideoTrack? = nil,
                                        audioMuted: Bool? = nil) {
        // The "local" identity is whatever LiveKit assigned — we don't have
        // it until after connect. Use the existing entry's identity or fall
        // back to a sentinel. The grid view filters by isLocal anyway.
        var arr = session.participants
        if let idx = arr.firstIndex(where: { $0.isLocal }) {
            let cur = arr[idx]
            arr[idx] = GroupParticipant(
                id: cur.id,
                identity: cur.identity,
                name: cur.name,
                videoTrack: videoTrack ?? cur.videoTrack,
                audioMuted: audioMuted ?? cur.audioMuted,
                isLocal: true
            )
        } else {
            let identity = room?.localParticipant.identity?.stringValue ?? "local"
            arr.append(GroupParticipant(
                id: "local:" + identity,
                identity: identity,
                name: "Você",
                videoTrack: videoTrack,
                audioMuted: audioMuted ?? false,
                isLocal: true
            ))
        }
        session.participants = arr
    }

    /// Append (or update if already present) a remote participant. Mirror of
    /// updateLocalParticipant — used from participantDidConnect /
    /// didSubscribeTrack / didUpdateIsMuted callbacks below.
    @MainActor
    private func upsertRemote(identity: String,
                              name: String? = nil,
                              videoTrack: VideoTrack? = nil,
                              audioMuted: Bool? = nil) {
        var arr = session.participants
        if let idx = arr.firstIndex(where: { $0.identity == identity && !$0.isLocal }) {
            let cur = arr[idx]
            arr[idx] = GroupParticipant(
                id: cur.id,
                identity: cur.identity,
                name: name ?? cur.name,
                videoTrack: videoTrack ?? cur.videoTrack,
                audioMuted: audioMuted ?? cur.audioMuted,
                isLocal: false
            )
        } else {
            arr.append(GroupParticipant(
                id: "remote:" + identity,
                identity: identity,
                name: name ?? identity,
                videoTrack: videoTrack,
                audioMuted: audioMuted ?? false,
                isLocal: false
            ))
        }
        session.participants = arr
    }

    @MainActor
    private func removeRemote(identity: String) {
        session.participants.removeAll { $0.identity == identity && !$0.isLocal }
    }

    deinit {
        // Belt-and-suspenders: drop the Room if some non-hangup path
        // dismissed us (system back gesture etc — we set isModalInPresentation
        // but a future SDK could still hit this).
        if let r = self.room {
            Task { await r.disconnect() }
        }
    }

    // MARK: - Presentation helper

    /// JSON shape expected by `participantsJson`:
    ///   [ { "identity": "alice@x", "name": "Alice", "audioMuted": false }, ... ]
    /// Any participant not in the initial roster will still appear once
    /// LiveKit reports participantDidConnect, so the JSON is purely
    /// optimistic — the grid renders avatar placeholders right away even
    /// before the Room handshake completes.
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
                isLocal: false
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
//
// Same minimal subset CallViewController implements. RoomDelegate methods
// are @objc optional in LiveKit Swift 2.x — we only get callbacks for the
// signatures we declare, so anything we don't need (connectionQuality,
// dataReceived, etc.) stays off until a future round needs it.

extension GroupCallViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[GroupCallVC] roomDidConnect — room=\(roomName)")
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "Conectado"
            // Refresh local identity in case the SDK assigned one different
            // from our placeholder.
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
        print("[GroupCallVC] participantDidConnect — identity=\(identity)")
        let displayName = (name?.isEmpty == false ? name : identity) ?? identity
        Task { @MainActor [weak self] in
            self?.upsertRemote(identity: identity, name: displayName)
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        print("[GroupCallVC] participantDidDisconnect — identity=\(identity)")
        Task { @MainActor [weak self] in
            self?.removeRemote(identity: identity)
        }
    }

    /// LiveKit Swift 2.x fires this for both audio + video; we set the video
    /// track on the matching tile and ignore audio (the WebRTC engine will
    /// route it to the AudioSession automatically). Signature kept identical
    /// to CallViewController so a future SDK rev hits both in one place.
    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else {
            print("[GroupCallVC] didSubscribeTrack — video pub but track cast failed")
            return
        }
        let identity = participant.identity?.stringValue ?? "?"
        print("[GroupCallVC] didSubscribeTrack — remote video identity=\(identity)")
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

    /// Audio-mute toggle on any participant — the LiveKit 2.x signature
    /// passes the publication that changed. We re-derive audioMuted from
    /// the publication's `isMuted` field; only react for audio kind so the
    /// mic-slash badge doesn't flicker on camera toggles.
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
}
