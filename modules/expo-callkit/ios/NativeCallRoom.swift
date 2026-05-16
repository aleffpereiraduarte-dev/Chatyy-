import Foundation
import UIKit

/**
 * NativeCallRoom — STUB (2026-05-15)
 *
 * Stage 2 iOS LiveKit pre-connect (via LiveKitClient pod) caused build/runtime
 * regression — the API surface used by the agent didn't match the installed
 * pod version. Reverting to stub. The JS-driven LiveKit connect via
 * @livekit/react-native (called from app/call.js) is what handles connection
 * in this build, same as before Stage 2 was attempted.
 *
 * Stage 2 v2 will be implemented in a separate session after verifying the
 * exact LiveKit Swift SDK API on a real device build.
 *
 * The CallKit + PKPushRegistry pre-arm path (VoipPushAppDelegateSubscriber)
 * remains active — that's what fixed the cold-start VoIP drop bug and is
 * independent of the LK Room pre-connect.
 *
 * NOTE (2026-05-15): The listener protocol + event enum below are kept so the
 * module file (which still references `extension ExpoCallKitModule:
 * NativeCallRoomListener`) compiles. The stub never emits events.
 */

/// Listener protocol bridging native LK events to the Expo Module's safeSendEvent.
public protocol NativeCallRoomListener: AnyObject {
    func nativeCallRoom(_ room: NativeCallRoom, didEmit event: NativeCallRoomEvent)
}

/// Mirrors the JS-visible onLk* event surface. Stage 2 v2 will emit these
/// from the LiveKit Room delegate; stub emits nothing.
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

    public private(set) var state: State = .idle
    public private(set) var lastRoomName: String?
    public private(set) var lastIdentity: String?

    public struct Snapshot {
        public let connected: Bool
        public let roomName: String?
        public let localIdentity: String?
        public let participants: [Any]
        public let connectionQuality: String
        public init() {
            connected = false; roomName = nil; localIdentity = nil
            participants = []; connectionQuality = "unknown"
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

    public func connect(url: String, token: String, identity: String, roomName: String) {
        print("[NativeCallRoom] Stub: connect(room=\(roomName), identity=\(identity)) — Stage 2 deferred")
    }

    public func disconnect() {
        print("[NativeCallRoom] Stub: disconnect()")
    }

    public func setMicEnabled(_ enabled: Bool) {
        print("[NativeCallRoom] Stub: setMicEnabled(\(enabled))")
    }

    public func setCameraEnabled(_ enabled: Bool) {
        print("[NativeCallRoom] Stub: setCameraEnabled(\(enabled))")
    }

    public func getSnapshot() -> Snapshot {
        return Snapshot()
    }

    @objc public func addListener(_ listener: AnyObject) {}
    @objc public func removeListener(_ listener: AnyObject) {}
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
        guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else {
            throw FetchError.missingAppGroup
        }
        guard let authToken = ud.string(forKey: "auth_token"), !authToken.isEmpty,
              let apiBase = ud.string(forKey: "api_base"), !apiBase.isEmpty else {
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

        // Mirror the JS body shape (apiCall POST puts the action into the
        // body too, so server-side $input always has it). `identity` and
        // `role` are accepted-but-ignored today; included for forward compat.
        let body: [String: Any] = [
            "action": "chat_livekit_token",
            "room": roomName,
            "identity": identity,
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
            throw FetchError.malformedResponse(bodyStr)
        }
        return TokenResult(token: token, url: lkUrl)
    }
}
