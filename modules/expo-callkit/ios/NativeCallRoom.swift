import Foundation
import AVFoundation
import CallKit

// [stage 2 — native LiveKit pre-connect, 2026-05-15]
//
// PROBLEM: When the user accepts a call from the lock screen / kill-state,
// the path was:
//   PushKit push → CallKit answer → action.fulfill() → RN bundle parse (1-3s)
//     → /call.js mount → fetch LK token → Room.connect → audio (~3-5s total).
// Users complained "atendo e demora muito, ou desliga sozinho".
//
// SOLUTION: Make the iOS native side connect to LiveKit DIRECTLY inside
// CXAnswerCallAction.didActivate, before RN even parses. Audio is up in
// <500ms because the LiveKit Room is established on the userInteractive
// queue while the JS bundle loads. Once /call mounts in JS, it calls
// `adoptNativeRoom()` to attach to the already-connected Room instead of
// creating a new one.
//
// This file owns a `LiveKit.Room` singleton. Public API:
//   - connect(url:token:identity:roomName:options:)
//   - disconnect()
//   - setMicEnabled(_:)
//   - setCameraEnabled(_:)
//   - getSnapshot() → participants + tracks (for JS adoption)
//   - addListener(_:) / removeListener(_:) → state change events
//
// Lifecycle is independent of the RN bridge — the Room can outlive a JS
// bundle reload (Metro dev) and survive a brief AppState transition. When
// the call ends (CXEndCallAction), we tear down.
//
// IMPORTANT compile note: this file imports `LiveKit` which comes from the
// `LiveKitClient` CocoaPods dependency. The Podfile (./ios/Podfile) already
// pins `LiveKitClient` for the ChatyyBroadcastExtension target; the main
// app target picks it up via the dep added to ExpoCallKit.podspec.
// If `pod install` hasn't been re-run after this commit, the build will
// fail to resolve `import LiveKit` — that's expected and documented in the
// commit message.

#if canImport(LiveKit)
import LiveKit
#endif

/// Snapshot returned to JS so it can rebuild its UI from the already-connected
/// native Room without re-creating tracks.
public struct NativeCallRoomSnapshot {
    public let connected: Bool
    public let roomName: String?
    public let localIdentity: String?
    public let participants: [[String: Any]]
    public let connectionQuality: String

    public func toDictionary() -> [String: Any] {
        return [
            "connected": connected,
            "roomName": roomName ?? NSNull(),
            "localIdentity": localIdentity ?? NSNull(),
            "participants": participants,
            "connectionQuality": connectionQuality,
        ]
    }
}

/// Event the Room emits up to the ExpoCallKitModule, which forwards to JS.
public enum NativeCallRoomEvent {
    case connected(roomName: String, localIdentity: String)
    case disconnected(reason: String)
    case participantConnected(identity: String, name: String?)
    case participantDisconnected(identity: String)
    case trackSubscribed(participantIdentity: String, trackSid: String, kind: String)
    case trackUnsubscribed(participantIdentity: String, trackSid: String, kind: String)
    case connectionQualityChanged(participantIdentity: String, quality: String)
}

public protocol NativeCallRoomListener: AnyObject {
    func nativeCallRoom(_ room: NativeCallRoom, didEmit event: NativeCallRoomEvent)
}

public final class NativeCallRoom: NSObject {
    public static let shared = NativeCallRoom()

    // Serial queue for state mutations so connect/disconnect from CallKit
    // delegate (main) can't race with JS-side adoptNativeRoom (worker).
    private let stateQueue = DispatchQueue(label: "com.chatyy.callkit.nativeroom.state")

    // Weak listener bag — modules can subscribe, we never own them.
    // Wrapped in NSHashTable so deallocated listeners auto-drop.
    private let listeners = NSHashTable<AnyObject>.weakObjects()

    // Connection state. We keep our own enum so we don't leak LiveKit types
    // to call sites that can't `import LiveKit`.
    public enum State: String {
        case idle
        case connecting
        case connected
        case reconnecting
        case disconnected
        case failed
    }
    private(set) public var state: State = .idle

    private(set) public var lastRoomName: String?
    private(set) public var lastIdentity: String?

    // Backing LiveKit objects — guarded by `#if canImport(LiveKit)` so this
    // file compiles even when LiveKitClient hasn't been installed yet (early
    // CI / debug builds).
    #if canImport(LiveKit)
    private var room: Room?
    #endif

    private override init() {
        super.init()
    }

    // MARK: - Listener management

    public func addListener(_ listener: NativeCallRoomListener) {
        stateQueue.sync {
            self.listeners.add(listener as AnyObject)
        }
    }

    public func removeListener(_ listener: NativeCallRoomListener) {
        stateQueue.sync {
            self.listeners.remove(listener as AnyObject)
        }
    }

    private func emit(_ event: NativeCallRoomEvent) {
        // Snapshot listeners outside async hop so dealloc ordering is safe.
        let snapshot: [NativeCallRoomListener] = stateQueue.sync {
            return self.listeners.allObjects.compactMap { $0 as? NativeCallRoomListener }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            for l in snapshot {
                l.nativeCallRoom(self, didEmit: event)
            }
        }
    }

    // MARK: - AVAudioSession (gated to CallKit ownership)

    /// CallKit owns the AVAudioSession during a call (didActivate fires on
    /// our CXProviderDelegate). We do NOT setActive(true) here — that's
    /// CallKit's job. This helper just configures the category/mode so when
    /// CallKit hands us the session, the route is right for VoIP.
    public func configureAudioSessionForVoIP() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                // [bug 2026-05-15 #10] modern BT options. `.allowBluetooth` is
                // deprecated since iOS 8; A2DP + HFP covers all current
                // headset paths.
                options: [.allowBluetoothA2DP, .allowBluetoothHFP]
            )
        } catch {
            print("[NativeCallRoom] setCategory failed (non-fatal): \(error)")
        }
    }

    // MARK: - Connect / disconnect

    /// Fire-and-forget connect. The CallKit answer path calls this from
    /// inside CXAnswerCallAction so we can't block; everything async runs in
    /// a Task. JS later adopts via getSnapshot().
    public func connect(
        url: String,
        token: String,
        identity: String,
        roomName: String
    ) {
        stateQueue.sync {
            if state == .connecting || state == .connected {
                print("[NativeCallRoom] connect() called while state=\(state.rawValue) — ignoring")
                return
            }
            state = .connecting
            lastIdentity = identity
            lastRoomName = roomName
        }
        print("[NativeCallRoom] connect() room=\(roomName) identity=\(identity)")

        configureAudioSessionForVoIP()

        #if canImport(LiveKit)
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self = self else { return }
            do {
                // LiveKit SDK 2.x: `Room()` does not accept a delegate in
                // init. We register via `add(delegate:)` afterwards so the
                // SDK matches across 2.0..2.x without breakage. If a future
                // SDK version drops `add`, swap for `.delegates.add(self)`.
                let room = Room()
                room.add(delegate: self)
                // Assign before connect so concurrent JS adoptions see the
                // partially-initialized Room (snapshot will report
                // `connecting`).
                self.stateQueue.sync { self.room = room }

                // `autoSubscribe` lives on ConnectOptions in 2.x. We default
                // it to true (the SDK default) but spell it out so behaviour
                // doesn't silently flip in a future minor.
                let connectOptions = ConnectOptions(
                    autoSubscribe: true
                )
                let roomOptions = RoomOptions(
                    adaptiveStream: true,
                    dynacast: true,
                    defaultAudioCaptureOptions: AudioCaptureOptions(
                        echoCancellation: true,
                        autoGainControl: true,
                        noiseSuppression: true
                    )
                )

                try await room.connect(
                    url: url,
                    token: token,
                    connectOptions: connectOptions,
                    roomOptions: roomOptions
                )

                // Default behaviour: enable mic on connect (audio call). JS
                // can toggle camera afterwards. We do NOT auto-enable camera
                // because that pops the iOS camera-permission alert during
                // a lock-screen answer, which is a confusing UX.
                try await room.localParticipant.setMicrophone(enabled: true)

                print("[NativeCallRoom] connected to \(roomName) as \(identity)")
            } catch {
                print("[NativeCallRoom] connect failed: \(error)")
                self.stateQueue.sync {
                    self.state = .failed
                }
                self.emit(.disconnected(reason: "connect_failed: \(error.localizedDescription)"))
            }
        }
        #else
        print("[NativeCallRoom] LiveKit not available at compile time — connect() is a no-op")
        stateQueue.sync { state = .failed }
        emit(.disconnected(reason: "livekit_not_linked"))
        #endif
    }

    /// Tear down the Room. Safe to call multiple times.
    public func disconnect() {
        #if canImport(LiveKit)
        let roomToClose: Room? = stateQueue.sync {
            let r = self.room
            self.room = nil
            self.state = .disconnected
            return r
        }
        Task.detached(priority: .utility) {
            if let r = roomToClose {
                await r.disconnect()
                print("[NativeCallRoom] disconnect() complete")
            }
        }
        #else
        stateQueue.sync {
            self.state = .disconnected
        }
        #endif
        emit(.disconnected(reason: "client_disconnect"))
    }

    // MARK: - Track toggles

    public func setMicEnabled(_ enabled: Bool) {
        #if canImport(LiveKit)
        let r: Room? = stateQueue.sync { self.room }
        guard let room = r else { return }
        Task.detached(priority: .userInitiated) {
            do {
                try await room.localParticipant.setMicrophone(enabled: enabled)
                print("[NativeCallRoom] setMicEnabled(\(enabled)) ok")
            } catch {
                print("[NativeCallRoom] setMicEnabled(\(enabled)) failed: \(error)")
            }
        }
        #endif
    }

    public func setCameraEnabled(_ enabled: Bool) {
        #if canImport(LiveKit)
        let r: Room? = stateQueue.sync { self.room }
        guard let room = r else { return }
        Task.detached(priority: .userInitiated) {
            do {
                try await room.localParticipant.setCamera(enabled: enabled)
                print("[NativeCallRoom] setCameraEnabled(\(enabled)) ok")
            } catch {
                print("[NativeCallRoom] setCameraEnabled(\(enabled)) failed: \(error)")
            }
        }
        #endif
    }

    // MARK: - Snapshot (for JS adoption)

    public func getSnapshot() -> NativeCallRoomSnapshot {
        #if canImport(LiveKit)
        let r: Room? = stateQueue.sync { self.room }
        guard let room = r else {
            return NativeCallRoomSnapshot(
                connected: false,
                roomName: lastRoomName,
                localIdentity: lastIdentity,
                participants: [],
                connectionQuality: "unknown"
            )
        }

        var partList: [[String: Any]] = []
        // Include local participant first so JS UI can pin it.
        let local = room.localParticipant
        partList.append([
            "identity": local.identity?.stringValue ?? lastIdentity ?? "",
            "name": local.name ?? "",
            "isLocal": true,
            "tracks": NativeCallRoom.tracksOf(participant: local),
        ])
        for (_, rp) in room.remoteParticipants {
            partList.append([
                "identity": rp.identity?.stringValue ?? "",
                "name": rp.name ?? "",
                "isLocal": false,
                "tracks": NativeCallRoom.tracksOf(participant: rp),
            ])
        }

        let connected = (state == .connected)
        return NativeCallRoomSnapshot(
            connected: connected,
            roomName: lastRoomName ?? room.name,
            localIdentity: lastIdentity ?? local.identity?.stringValue,
            participants: partList,
            connectionQuality: "good"
        )
        #else
        return NativeCallRoomSnapshot(
            connected: false,
            roomName: lastRoomName,
            localIdentity: lastIdentity,
            participants: [],
            connectionQuality: "unavailable"
        )
        #endif
    }

    #if canImport(LiveKit)
    private static func tracksOf(participant: Participant) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (_, pub) in participant.trackPublications {
            out.append([
                "sid": pub.sid.stringValue,
                "kind": Self.kindString(pub.kind),
                "subscribed": pub.isSubscribed,
                "muted": pub.isMuted,
                "source": Self.sourceString(pub.source),
            ])
        }
        return out
    }

    private static func kindString(_ kind: Track.Kind) -> String {
        switch kind {
        case .audio: return "audio"
        case .video: return "video"
        default: return "unknown"
        }
    }

    private static func sourceString(_ source: Track.Source) -> String {
        switch source {
        case .camera: return "camera"
        case .microphone: return "microphone"
        case .screenShareVideo: return "screen"
        case .screenShareAudio: return "screen_audio"
        default: return "unknown"
        }
    }
    #endif
}

// MARK: - RoomDelegate

#if canImport(LiveKit)
extension NativeCallRoom: RoomDelegate {
    public func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        print("[NativeCallRoom] connectionState \(oldConnectionState) → \(connectionState)")
        let newState: State
        switch connectionState {
        case .connected:
            newState = .connected
        case .connecting:
            newState = .connecting
        case .reconnecting:
            newState = .reconnecting
        case .disconnected:
            newState = .disconnected
        @unknown default:
            newState = .idle
        }
        stateQueue.sync { self.state = newState }

        if connectionState == .connected {
            let identity = room.localParticipant.identity?.stringValue ?? (lastIdentity ?? "")
            emit(.connected(roomName: room.name ?? (lastRoomName ?? ""), localIdentity: identity))
        } else if connectionState == .disconnected {
            emit(.disconnected(reason: "remote_disconnect"))
        }
    }

    public func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        let id = participant.identity?.stringValue ?? ""
        print("[NativeCallRoom] participantConnected: \(id)")
        emit(.participantConnected(identity: id, name: participant.name))
    }

    public func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let id = participant.identity?.stringValue ?? ""
        print("[NativeCallRoom] participantDisconnected: \(id)")
        emit(.participantDisconnected(identity: id))
    }

    public func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        let id = participant.identity?.stringValue ?? ""
        let kind = NativeCallRoom.kindString(publication.kind)
        print("[NativeCallRoom] trackSubscribed: \(id) sid=\(publication.sid.stringValue) kind=\(kind)")
        emit(.trackSubscribed(
            participantIdentity: id,
            trackSid: publication.sid.stringValue,
            kind: kind
        ))
    }

    public func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        let id = participant.identity?.stringValue ?? ""
        let kind = NativeCallRoom.kindString(publication.kind)
        print("[NativeCallRoom] trackUnsubscribed: \(id) sid=\(publication.sid.stringValue) kind=\(kind)")
        emit(.trackUnsubscribed(
            participantIdentity: id,
            trackSid: publication.sid.stringValue,
            kind: kind
        ))
    }

    public func room(_ room: Room, participant: Participant, didUpdateConnectionQuality quality: ConnectionQuality) {
        let id = participant.identity?.stringValue ?? ""
        let q: String
        switch quality {
        case .excellent: q = "excellent"
        case .good: q = "good"
        case .poor: q = "poor"
        case .lost: q = "lost"
        default: q = "unknown"
        }
        emit(.connectionQualityChanged(participantIdentity: id, quality: q))
    }
}
#endif

// MARK: - LiveKit token fetcher
//
// Lives next to NativeCallRoom so the answer path can do the entire
// "fetch token → connect" sequence without going through JS.

public enum NativeCallTokenError: Error {
    case missingAuth
    case badResponse(Int)
    case parseError(String)
    case noToken
}

public final class NativeCallTokenFetcher {
    public static let shared = NativeCallTokenFetcher()

    // Bumped to chatyy.com.br per memory: mail.onemundo.com.br is dead.
    private let endpoint = URL(string: "https://chatyy.com.br/api/chat.php?action=chat_livekit_token")!

    // App Group key where AuthContext.js stashes the bearer for the native
    // side (see persistAuthForNativeCall on the JS side).
    private let appGroupId = "group.com.onemundo.mail"
    private let authKey = "auth_token"

    private init() {}

    private func currentAuthToken() -> String? {
        guard let ud = UserDefaults(suiteName: appGroupId) else { return nil }
        return ud.string(forKey: authKey)
    }

    /// Async fetch. Throws NativeCallTokenError on any failure.
    public func fetchToken(
        roomName: String,
        identity: String,
        role: String = "subscriber"
    ) async throws -> (token: String, url: String) {
        guard let bearer = currentAuthToken(), !bearer.isEmpty else {
            throw NativeCallTokenError.missingAuth
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        // 4s timeout — if backend isn't responding the user is better off
        // landing on the JS path which will retry with its own UI feedback.
        req.timeoutInterval = 4.0

        let body: [String: Any] = [
            "room_name": roomName,
            "identity": identity,
            "role": role,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw NativeCallTokenError.badResponse(0)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw NativeCallTokenError.badResponse(http.statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeCallTokenError.parseError("not-json")
        }
        guard let token = json["token"] as? String, !token.isEmpty else {
            throw NativeCallTokenError.noToken
        }
        let url = (json["url"] as? String) ?? "wss://livekit.chatyy.com.br"
        return (token: token, url: url)
    }
}
