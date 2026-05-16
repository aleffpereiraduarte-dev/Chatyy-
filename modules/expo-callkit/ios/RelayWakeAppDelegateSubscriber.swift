import ExpoModulesCore
import UIKit
import Foundation

// [2026-05-16 Stage 4] Silent push wake → raw WebSocket session (iOS).
//
// Background pushes (apns-push-type=background, content-available=1)
// arrive via UIApplicationDelegate.application(_:didReceiveRemoteNotification:
// fetchCompletionHandler:). Expo's UNUserNotificationCenter delegate hooks
// the foreground/banner path, but the silent path is a DIFFERENT method on
// the UIApplicationDelegate protocol and is not claimed by expo-notifications.
//
// We register this class as an `appDelegateSubscribers` entry in
// expo-module.config.json. ExpoModulesCore wires our subscriber into the
// generated AppDelegate at build time, surviving `expo prebuild --clean`.
//
// SILENT contract: no visible UI, no sound, no vibration. Apple rate-limits
// these pushes to ~2-3/hour per device — best-effort only.
//
// Lifecycle when wake_relay arrives:
//   1. beginBackgroundTask (25s budget — Apple allows ~30s; we leave 5s for
//      cleanup so iOS doesn't kill us forcibly).
//   2. Open a URLSessionWebSocketTask to wss://ws.chatyy.com.br/ws.
//   3. Send {type:"auth", token} — token comes from App Group UserDefaults
//      where AuthContext persists it on login (key "auth_token").
//   4. On auth_success → subscribe chat_user_<email>, then send relay_ready.
//   5. Listen for relay_request frames up to PHONE_WS_HOLD_MS (10s).
//   6. Close socket, endBackgroundTask, call fetchCompletionHandler(.newData).

private let kAppGroupId = "group.com.onemundo.mail"
private let kWsUrl = "wss://ws.chatyy.com.br/ws"
private let kHoldWindowSeconds: TimeInterval = 10
private let kAuthTimeoutSeconds: TimeInterval = 5
private let kBgTaskBudgetSeconds: TimeInterval = 25

public class RelayWakeAppDelegateSubscriber: ExpoAppDelegateSubscriber {

    // Track active session so a second wake push during a still-running
    // session doesn't open a second WS (Apple rate-limits anyway, but be
    // defensive). Keyed by requestId.
    private static var activeSession: RelayWakeSession?
    private static let lock = NSLock()

    // NOTE on protocol shape: ExpoAppDelegateSubscriberManager fans this
    // method out to every subscriber that responds to the selector, and
    // aggregates the UIBackgroundFetchResult values. So every subscriber
    // must call completionHandler exactly once — even when it has no
    // interest in the push. We pass .noData to short-circuit when the
    // push isn't for us. Firebase / expo-notifications handle their own
    // FCM-mapped pushes in parallel; no chaining/return semantics apply.
    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        let type = (userInfo["type"] as? String)
            ?? ((userInfo["aps"] as? [String: Any])?["type"] as? String)
            ?? ""
        if type != "wake_relay" {
            // Not for us — yield without doing any work. Some other
            // subscriber (or the app's default handling) owns this push.
            completionHandler(.noData)
            return
        }

        let requestId = (userInfo["requestId"] as? String)
            ?? (userInfo["request_id"] as? String)
            ?? ((userInfo["aps"] as? [String: Any])?["requestId"] as? String)
            ?? ""

        NSLog("[RelayWake] wake_relay push received, requestId=%@", requestId)

        Self.lock.lock()
        if Self.activeSession != nil {
            Self.lock.unlock()
            NSLog("[RelayWake] session already active — ignoring duplicate")
            completionHandler(.noData)
            return
        }
        let session = RelayWakeSession(requestId: requestId) { result in
            Self.lock.lock()
            Self.activeSession = nil
            Self.lock.unlock()
            completionHandler(result)
        }
        Self.activeSession = session
        Self.lock.unlock()

        session.start()
    }
}

// MARK: - RelayWakeSession

private final class RelayWakeSession: NSObject, URLSessionWebSocketDelegate {
    private let requestId: String
    private let completion: (UIBackgroundFetchResult) -> Void
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var didFinish = false
    private var authenticated = false
    private let queue = DispatchQueue(label: "com.chatyy.relayWake", qos: .userInitiated)

    init(requestId: String, completion: @escaping (UIBackgroundFetchResult) -> Void) {
        self.requestId = requestId
        self.completion = completion
    }

    func start() {
        // 1. Background task — must be claimed BEFORE we leave the push
        //    delivery callback or iOS suspends us within ~250ms.
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "RelayWake") { [weak self] in
            NSLog("[RelayWake] bg task expired by OS")
            self?.finish(.failed)
        }
        if bgTaskId == .invalid {
            NSLog("[RelayWake] beginBackgroundTask returned invalid — bailing")
            completion(.failed)
            return
        }

        // 2. Hard ceiling watchdog — even if every other timeout fails, we
        //    finish before the OS forcibly terminates us.
        queue.asyncAfter(deadline: .now() + kBgTaskBudgetSeconds) { [weak self] in
            guard let self = self, !self.didFinish else { return }
            NSLog("[RelayWake] hard watchdog elapsed")
            self.finish(.newData)
        }

        // 3. Load credentials from App Group prefs (persisted on login).
        guard let ud = UserDefaults(suiteName: kAppGroupId) else {
            NSLog("[RelayWake] App Group UserDefaults unavailable")
            finish(.failed)
            return
        }
        guard let authToken = ud.string(forKey: "auth_token"), !authToken.isEmpty,
              let userEmail = (ud.string(forKey: "user_email") ?? ud.string(forKey: "auth_email")),
              !userEmail.isEmpty else {
            NSLog("[RelayWake] missing auth_token or user_email in App Group")
            finish(.noData)
            return
        }
        let userEmailLc = userEmail.lowercased()

        // 4. Open WS.
        guard let url = URL(string: kWsUrl) else {
            finish(.failed); return
        }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.urlSession = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()

        // 5. Auth timeout — bail if we never reach auth_success.
        queue.asyncAfter(deadline: .now() + kAuthTimeoutSeconds) { [weak self] in
            guard let self = self else { return }
            if !self.authenticated && !self.didFinish {
                NSLog("[RelayWake] auth timeout — closing")
                self.finish(.noData)
            }
        }

        // 6. Send auth + start receive loop.
        sendJson(["type": "auth", "token": authToken])
        receiveLoop(userEmailLc: userEmailLc)

        // 7. Hold window — close cleanly after PHONE_WS_HOLD_MS.
        queue.asyncAfter(deadline: .now() + kHoldWindowSeconds) { [weak self] in
            guard let self = self, !self.didFinish else { return }
            NSLog("[RelayWake] hold window elapsed — finishing")
            self.finish(.newData)
        }
    }

    private func receiveLoop(userEmailLc: String) {
        guard let task = self.task else { return }
        task.receive { [weak self] result in
            guard let self = self, !self.didFinish else { return }
            switch result {
            case .failure(let err):
                NSLog("[RelayWake] receive error: %@", err.localizedDescription)
                self.finish(.failed)
            case .success(let msg):
                switch msg {
                case .string(let text):
                    self.handleFrame(text, userEmailLc: userEmailLc)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleFrame(text, userEmailLc: userEmailLc)
                    }
                @unknown default:
                    break
                }
                if !self.didFinish {
                    self.receiveLoop(userEmailLc: userEmailLc)
                }
            }
        }
    }

    private func handleFrame(_ text: String, userEmailLc: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let type = (obj["type"] as? String) ?? ""
        switch type {
        case "auth_success":
            NSLog("[RelayWake] authenticated")
            authenticated = true
            // Subscribe to personal channel so server can deliver relay_request.
            sendJson(["type": "subscribe", "channel": "chat_user_\(userEmailLc)"])
            // Tell server we're ready — drains the wake-pending queue.
            sendJson(["type": "relay_ready", "requestId": requestId])
        case "auth_error":
            NSLog("[RelayWake] auth_error — stale token; finishing")
            finish(.noData)
        case "relay_request":
            // Native path can't read the JS SQLite db. Respond with
            // js_unavailable so the requester knows the JS bundle must
            // handle this on the next attempt. The silent push itself
            // typically wakes the headless background JS task within
            // a few seconds.
            let reqId = (obj["requestId"] as? String) ?? ""
            let requester = (obj["requester"] as? String) ?? ""
            NSLog("[RelayWake] native relay_request received requestId=%@", reqId)
            sendJson([
                "type": "relay_response",
                "requestId": reqId,
                "target_email": requester,
                "error": "js_unavailable",
            ])
        default:
            break
        }
    }

    private func sendJson(_ obj: [String: Any]) {
        guard let task = self.task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { err in
            if let err = err {
                NSLog("[RelayWake] send error: %@", err.localizedDescription)
            }
        }
    }

    private func finish(_ result: UIBackgroundFetchResult) {
        queue.async { [weak self] in
            guard let self = self, !self.didFinish else { return }
            self.didFinish = true
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.urlSession?.invalidateAndCancel()
            self.urlSession = nil
            if self.bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(self.bgTaskId)
                self.bgTaskId = .invalid
            }
            self.completion(result)
        }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        NSLog("[RelayWake] WS opened")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        NSLog("[RelayWake] WS closed code=%d", closeCode.rawValue)
        finish(.newData)
    }
}
