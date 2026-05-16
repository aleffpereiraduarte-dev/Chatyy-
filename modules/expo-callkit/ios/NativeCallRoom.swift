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
 */
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

/// NativeCallTokenFetcher — stub for the LK token HTTP fetcher referenced by
/// VoipPushAppDelegateSubscriber. Stage 2 v2 will reimplement.
public class NativeCallTokenFetcher {
    public struct TokenResult {
        public let token: String
        public let url: String
    }
    public static let shared = NativeCallTokenFetcher()
    public func fetchToken(roomName: String, identity: String, role: String) async throws -> TokenResult {
        throw NSError(domain: "NativeCallTokenFetcher", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "Stub: token fetch deferred to Stage 2 v2"])
    }
}
