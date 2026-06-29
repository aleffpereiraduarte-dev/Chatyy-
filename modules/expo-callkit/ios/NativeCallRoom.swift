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
        // [iOS call E2EE, 2026-06-28] Drop any per-call key so it can't leak
        // into the next call (which mints its own fresh key when E2EE is on).
        if let cid = _callId { clearE2EEKey(callId: cid) }
        self.room = nil
        self._callId = nil
        self.lastRoomName = nil
        self.lastIdentity = nil
        self.state = .idle
    }

    public func currentCallId() -> String? { return _callId }

    // --- E2EE (call media encryption) — GATED, DEFAULT OFF --------------------
    //
    // [iOS call E2EE, 2026-06-28] LiveKit Swift exposes insertable-streams E2EE
    // via `E2EEOptions(keyProvider:)`. We mirror the Android strategy: JS mints
    // a per-call shared key and hands it to native through
    // `ExpoCallKit.setCallE2EEKey(callId, keyBase64)` BEFORE the Room connects.
    // The sole Room builder (`CallViewController`) calls
    // `makeE2EEOptions(forCallId:)` while assembling `RoomOptions`; when a key
    // is registered it attaches `E2EEOptions(keyProvider: BaseKeyProvider(
    // sharedKey:))`, otherwise it returns nil and the Room connects EXACTLY as
    // it does today (no E2EE).
    //
    // ⚠️ DEFAULT OFF: no key is ever registered unless JS — behind its own
    // feature flag — calls `setCallE2EEKey`. With the store empty,
    // `makeE2EEOptions` returns nil and the connect path is byte-for-byte
    // identical to the pre-E2EE behavior. There is no autonomous code path that
    // turns this on; it is purely key-gated.
    private var pendingE2EEKeys: [String: String] = [:]
    private let e2eeLock = NSLock()

    /// Register the per-call shared E2EE key (base64). Invoked from the Expo
    /// module's `setCallE2EEKey` Function, which JS calls before connect.
    @objc public func setE2EEKey(callId: String, keyBase64: String) {
        guard !callId.isEmpty, !keyBase64.isEmpty else { return }
        e2eeLock.lock(); defer { e2eeLock.unlock() }
        pendingE2EEKeys[callId] = keyBase64
        print("[NativeCallRoom] E2EE key registered for callId=\(callId) (len=\(keyBase64.count))")
    }

    /// Drop a stored key (call ended / cleared). Also invoked from `clear()`.
    @objc public func clearE2EEKey(callId: String) {
        guard !callId.isEmpty else { return }
        e2eeLock.lock(); defer { e2eeLock.unlock() }
        pendingE2EEKeys.removeValue(forKey: callId)
    }

    private func e2eeKey(forCallId callId: String) -> String? {
        e2eeLock.lock(); defer { e2eeLock.unlock() }
        return pendingE2EEKeys[callId]
    }

    /// Build `E2EEOptions` for the given callId, or nil when no key is
    /// registered (→ connect without E2EE, today's behavior). Centralizes all
    /// LiveKit E2EE type usage so the Room builder only passes the optional
    /// through to `RoomOptions(e2eeOptions:)`.
    public func makeE2EEOptions(forCallId callId: String) -> E2EEOptions? {
        guard let key = e2eeKey(forCallId: callId) else { return nil }
        // BaseKeyProvider with a single shared key (no per-participant ratchet).
        // ⚠️ KEY-CONTRACT MISMATCH — MUST RESOLVE BEFORE ENABLING CALL_E2EE:
        // Android decodes the base64 → RAW 32 bytes and feeds those via
        // rtcKeyProvider.setSharedKey(index, ByteArray). Here we pass the base64
        // STRING straight into BaseKeyProvider(sharedKey:), and LiveKit Swift uses
        // the string's UTF-8 bytes as key material → DIFFERENT bytes than Android,
        // so cross-platform frames would NOT decrypt. During QA (Pods installed),
        // decode `key` (base64 → Data) and feed RAW bytes to whatever Data-based
        // key API the pinned LiveKitClient exposes, so both platforms use the same
        // 32 raw bytes. Same-platform (iOS↔iOS) works today; iOS↔Android does not.
        let keyProvider = BaseKeyProvider(isSharedKey: true, sharedKey: key)
        let opts = E2EEOptions(keyProvider: keyProvider)
        print("[NativeCallRoom] E2EE ENABLED for callId=\(callId) (shared-key)")
        return opts
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
                    // [Wave WhatsApp parity, 2026-05-20 gap C1+C4] Mirror the
                    // CallViewController publish path: VP9 preferred / VP8 backup,
                    // simulcast on, balanced degradation. Without these options
                    // the JS-triggered camera enable would publish a default VP8
                    // track and the SFU would never negotiate VP9 with peers.
                    let publishOpts = VideoPublishOptions(
                        name: nil,
                        encoding: VideoEncoding(maxBitrate: 2_000_000, maxFps: 30),
                        // [VIDEO FIX 2026-05-26] simulcast=false with H.264 —
                        // libwebrtc has no H.264 simulcast; true here made the
                        // camera publish fail silently (no self-view + no remote).
                        // Mirrors CallViewController.defaultVideoPublishOptions.
                        simulcast: false,
                        // [remote-video render fix 2026-05-26] .vp9 → .h264 to
                        // match CallViewController.defaultVideoPublishOptions. VP9
                        // decode is unreliable cross-platform on mobile and was why
                        // the remote peer's camera never rendered (avatar only); H.264
                        // is HW-decoded everywhere. Must stay in sync with the other
                        // two publish sites or SFU codec negotiation goes asymmetric.
                        preferredCodec: .h264,
                        // [Wave 19 fix] LK iOS 2.0.x has no backupCodec param.
                        // [HD tuning 2026-05-26] maintainFramerate — keep fps,
                        // shed resolution first under congestion (talking-head).
                        // Mirrors CallViewController.defaultVideoPublishOptions.
                        degradationPreference: .maintainFramerate
                    )
                    _ = try await r.localParticipant.setCamera(
                        enabled: true,
                        publishOptions: publishOpts
                    )
                } else {
                    _ = try await r.localParticipant.setCamera(enabled: false)
                }
            } catch {
                print("[NativeCallRoom] setCameraEnabled(\(enabled)) failed: \(error)")
            }
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
    }
    public static let shared = NativeCallTokenFetcher()

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
        NSLog("[CallTrace][7b/12] LkTokenFetcher result success=true url=\(lkUrl) elapsedMs=\(Int(Date().timeIntervalSince1970 * 1000 - __ct_t0))")
        return TokenResult(token: token, url: lkUrl)
    }
}
