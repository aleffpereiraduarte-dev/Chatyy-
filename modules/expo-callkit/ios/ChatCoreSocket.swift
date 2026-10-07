import Foundation
import UIKit

/// [2026-10-07 native-core] ChatCoreSocket — phase 1 of the native messaging
/// core (iOS twin of ChatCoreSocket.kt). SHADOW socket:
///   - opened only while the app is in the foreground (JS start() on 'active';
///     native closes it on didEnterBackground and reopens on willEnterForeground
///     while enabled — iOS suspends the process in background anyway, so a
///     background socket is neither possible nor attempted);
///   - same protocol as services/websocket.js: auth{token, instance_id,
///     device_id, client, platform} → auth_success → resume{last_event_id} →
///     app-level ping/pong;
///   - chat_message / chat_summary → one ChatBgJournal line (src "ws") + JS
///     event; message_delivered / message_read → JS event only (the journal
///     format is message-only);
///   - sends nothing but auth / resume / ping. The JS socket keeps doing all
///     the real work. Own "nc-…" instance_id → the hub never supersedes the
///     JS socket because of us.
/// Nothing here runs unless JS calls start() (NATIVE_CORE_ENABLED flag).
final class ChatCoreSocket {
    static let shared = ChatCoreSocket()

    private let wsURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private let groupId = "group.com.onemundo.mail"
    private let lastEventKey = "chat_core_last_event_id"
    private let lastEventAcctKey = "chat_core_last_event_acct"
    private let pingInterval: TimeInterval = 25
    private let pongDeadline: TimeInterval = 10
    private let authWatchdog: TimeInterval = 6
    private let backoff: [TimeInterval] = [1, 2, 4, 8, 16, 30]
    private let seenMax = 1024

    /// (eventName, body) → ChatCoreModule.sendEvent. Set in OnCreate.
    var emitter: ((String, [String: Any?]) -> Void)?

    private let q = DispatchQueue(label: "chatyy.chatcore.ws")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var enabled = false
    private var connecting = false
    private var authed = false
    private var inForeground = true
    private var attempts = 0
    private var lastEventId: Int64 = 0
    private var eventsSinceFlush = 0
    private var lastPongAt: Date = .distantPast
    private var expectedAcct = ""
    private var authedAcct = ""
    private var deviceId = ""
    private var instanceId = ""
    private var pingTimer: DispatchSourceTimer?
    private var reconnectItem: DispatchWorkItem?
    private var watchdogItem: DispatchWorkItem?
    private var observersInstalled = false
    private var observerTokens: [NSObjectProtocol] = []
    private var stats: [String: Int64] = [:]
    private var seenOrder: [String] = []
    private var seenSet = Set<String>()

    private init() {}

    // MARK: - Public API

    func start(acct: String, jsLastEventId: Int64, deviceId devId: String) {
        q.async {
            self.installObserversLocked()
            let a = Self.normEmail(acct)
            if a != self.expectedAcct {
                self.closeLocked(reason: "acct_switch")
                self.authedAcct = ""
                self.lastEventId = 0
            }
            self.expectedAcct = a
            self.deviceId = devId
            if self.instanceId.isEmpty {
                self.instanceId = "nc-" + String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
                    + String(Int64.random(in: 0..<1_000_000_000), radix: 36)
            }
            var stored: Int64 = 0
            if let ud = UserDefaults(suiteName: self.groupId),
               (ud.string(forKey: self.lastEventAcctKey) ?? "") == a {
                stored = (ud.object(forKey: self.lastEventKey) as? NSNumber)?.int64Value ?? 0
            }
            self.lastEventId = max(self.lastEventId, stored, jsLastEventId)
            self.inForeground = true
            let wasEnabled = self.enabled
            self.enabled = true
            if wasEnabled && (self.authed || self.connecting) { return }
            self.attempts = 0
            self.stats = [:]
            self.startPingLocked()
            self.connectLocked()
        }
    }

    func stop(reason: String) {
        q.async { self.stopLocked(reason: reason) }
    }

    func isRunning() -> Bool { return q.sync { () -> Bool in enabled } }

    func snapshot() -> [String: Any] {
        return q.sync { () -> [String: Any] in
            var s: [String: Any] = [:]
            for (k, v) in stats { s[k] = NSNumber(value: v) }
            return [
                "enabled": enabled, "connecting": connecting, "authenticated": authed,
                "acct": authedAcct, "lastEventId": NSNumber(value: lastEventId),
                "instanceId": instanceId, "stats": s,
            ]
        }
    }

    // MARK: - Lifecycle (foreground only)

    private func installObserversLocked() {
        if observersInstalled { return }
        observersInstalled = true
        let nc = NotificationCenter.default
        let bgTok = nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self = self else { return }
            self.q.async {
                self.inForeground = false
                guard self.enabled else { return }
                self.bump("close_background")
                self.persistLocked(force: true)
                self.closeLocked(reason: "background")
            }
        }
        let fgTok = nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self = self else { return }
            self.q.async {
                self.inForeground = true
                guard self.enabled, self.task == nil else { return }
                self.attempts = 0
                self.connectLocked()
            }
        }
        observerTokens = [bgTok, fgTok]
    }

    // MARK: - Internals (all on q)

    private func bump(_ k: String, _ by: Int64 = 1) { stats[k, default: 0] += by }

    private func emitState(_ state: String, _ extra: [String: Any?] = [:]) {
        var body = extra
        body["state"] = state
        body["at"] = Date().timeIntervalSince1970 * 1000
        let e = emitter
        DispatchQueue.main.async { e?("onChatCoreState", body) }
    }

    private func emitFrame(_ body: [String: Any?]) {
        let e = emitter
        DispatchQueue.main.async { e?("onChatCoreFrame", body) }
    }

    private func stopLocked(reason: String) {
        enabled = false
        reconnectItem?.cancel(); reconnectItem = nil
        pingTimer?.cancel(); pingTimer = nil
        persistLocked(force: true)
        closeLocked(reason: reason)
    }

    private func closeLocked(reason: String) {
        watchdogItem?.cancel(); watchdogItem = nil
        authed = false
        connecting = false
        guard let t = task else { return }
        task = nil
        t.cancel(with: .normalClosure, reason: reason.data(using: .utf8))
        emitState("closed", ["reason": reason])
    }

    private func bearer() -> String? {
        guard let ud = UserDefaults(suiteName: groupId),
              let tok = ud.string(forKey: "auth_token"), !tok.isEmpty else { return nil }
        return tok
    }

    private func connectLocked() {
        guard enabled, inForeground else { bump("skip_background"); return }
        if authed, task != nil { return }
        if connecting { return }
        guard let token = bearer() else {
            bump("no_bearer")
            emitState("no_bearer")
            return
        }
        connecting = true
        if session == nil {
            let cfg = URLSessionConfiguration.default
            cfg.waitsForConnectivity = false
            cfg.timeoutIntervalForRequest = 10
            session = URLSession(configuration: cfg)
        }
        if let old = task {
            task = nil
            old.cancel(with: .goingAway, reason: nil)
        }
        guard let s = session else { connecting = false; return }
        let t = s.webSocketTask(with: wsURL)
        task = t
        bump("connect")
        emitState("connecting")
        t.resume()
        let auth: [String: Any] = [
            "type": "auth", "token": token, "instance_id": instanceId,
            "device_id": deviceId, "client": "native-core", "platform": "ios",
        ]
        sendLocked(t, auth)
        let wd = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.task === t && !self.authed {
                self.bump("auth_watchdog")
                self.disconnectLocked(from: t, why: "auth_watchdog")
            }
        }
        watchdogItem?.cancel()
        watchdogItem = wd
        q.asyncAfter(deadline: .now() + authWatchdog, execute: wd)
        receiveLoop(t)
    }

    private func sendLocked(_ t: URLSessionWebSocketTask, _ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { [weak self] err in
            guard let self = self, err != nil else { return }
            self.q.async { self.disconnectLocked(from: t, why: "send_failed") }
        }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                self.q.async { self.disconnectLocked(from: t, why: "receive_failed") }
            case .success(let m):
                var text: String?
                switch m {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: text = nil
                }
                self.q.async {
                    guard self.task === t, self.enabled else { return }
                    if let tx = text { self.handleFrameLocked(t, tx) }
                }
                self.receiveLoop(t)
            }
        }
    }

    private func disconnectLocked(from t: URLSessionWebSocketTask, why: String) {
        guard task === t else { return } // stale callback of an old task
        task = nil
        t.cancel(with: .goingAway, reason: nil)
        watchdogItem?.cancel(); watchdogItem = nil
        authed = false
        connecting = false
        bump("disconnect")
        emitState("closed", ["reason": why])
        persistLocked(force: true)
        scheduleReconnectLocked()
    }

    private func scheduleReconnectLocked() {
        guard enabled, inForeground else { return }
        if reconnectItem != nil { return }
        let wait = backoff[min(attempts, backoff.count - 1)]
        attempts += 1
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.reconnectItem = nil
            self.connectLocked()
        }
        reconnectItem = item
        q.asyncAfter(deadline: .now() + wait, execute: item)
    }

    private func startPingLocked() {
        pingTimer?.cancel()
        let tm = DispatchSource.makeTimerSource(queue: q)
        tm.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        tm.setEventHandler { [weak self] in
            guard let self = self, self.enabled, self.inForeground else { return }
            guard let t = self.task else {
                if !self.connecting && self.reconnectItem == nil { self.attempts = 0; self.connectLocked() }
                return
            }
            guard self.authed else { return }
            let sentAt = Date()
            self.sendLocked(t, ["type": "ping", "ts": NSNumber(value: Int64(sentAt.timeIntervalSince1970 * 1000))])
            self.q.asyncAfter(deadline: .now() + self.pongDeadline) { [weak self] in
                guard let self = self else { return }
                if self.task === t && self.authed && self.lastPongAt < sentAt {
                    self.bump("pong_timeout")
                    self.disconnectLocked(from: t, why: "pong_timeout")
                }
            }
        }
        tm.resume()
        pingTimer = tm
    }

    private func persistLocked(force: Bool) {
        if !force && eventsSinceFlush < 10 { return }
        eventsSinceFlush = 0
        guard let ud = UserDefaults(suiteName: groupId) else { return }
        ud.set(NSNumber(value: lastEventId), forKey: lastEventKey)
        ud.set(authedAcct.isEmpty ? expectedAcct : authedAcct, forKey: lastEventAcctKey)
    }

    private func handleFrameLocked(_ t: URLSessionWebSocketTask, _ text: String) {
        guard let d = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        let type = (msg["type"] as? String) ?? ""
        bump("rx")
        let ev = Self.int64(msg["event_id"]) ?? 0
        if ev > lastEventId {
            lastEventId = ev
            eventsSinceFlush += 1
            persistLocked(force: false)
        }
        switch type {
        case "auth_success":
            let email = Self.normEmail(msg["email"] as? String)
            if !expectedAcct.isEmpty && !email.isEmpty && email != expectedAcct {
                bump("acct_mismatch")
                emitState("acct_mismatch", ["email": email])
                stopLocked(reason: "acct_mismatch")
                return
            }
            authedAcct = email.isEmpty ? expectedAcct : email
            authed = true
            connecting = false
            attempts = 0
            watchdogItem?.cancel(); watchdogItem = nil
            lastPongAt = Date()
            bump("auth_ok")
            emitState("authenticated", ["email": authedAcct])
            sendLocked(t, ["type": "resume", "last_event_id": NSNumber(value: lastEventId)])
        case "auth_error":
            bump("auth_error")
            let reason = (msg["reason"] as? String) ?? ""
            let fatal = (msg["fatal"] as? Bool) == true || reason == "logged_out"
            emitState(fatal ? "fatal" : "auth_error", ["reason": reason])
            if fatal { stopLocked(reason: "logged_out") }
        case "pong":
            lastPongAt = Date()
        case "session_replaced":
            bump("session_replaced")
            emitState("replaced")
            stopLocked(reason: "session_replaced")
        case "resume_result":
            if let l = Self.int64(msg["last_event_id"]), l > lastEventId { lastEventId = l }
            persistLocked(force: true)
            bump("resume_replayed", Self.int64(msg["count"]) ?? 0)
            if (msg["has_more"] as? Bool) == true {
                sendLocked(t, ["type": "resume", "last_event_id": NSNumber(value: lastEventId)])
            }
        case "resume_complete":
            bump("resume_replayed", Self.int64(msg["count"]) ?? 0)
        case "resume_full_sync":
            if let c = Self.int64(msg["current_event_id"]), c > lastEventId { lastEventId = c }
            persistLocked(force: true)
            bump("resume_full_sync")
            emitState("full_sync", ["reason": (msg["reason"] as? String) ?? ""])
        case "chat_message", "chat_summary":
            onChatFrameLocked(type, msg, ev)
        case "message_delivered", "message_read":
            bump(type)
            let data = (msg["data"] as? [String: Any]) ?? msg
            emitFrame([
                "type": type,
                "cid": Double(Self.int64(data["conversation_id"]) ?? 0),
                "mid": Double(Self.int64(data["message_id"]) ?? 0),
                "eventId": Double(ev),
                "at": Date().timeIntervalSince1970 * 1000,
            ])
        default:
            break
        }
    }

    private func onChatFrameLocked(_ type: String, _ msg: [String: Any], _ ev: Int64) {
        bump(type)
        let data = (msg["data"] as? [String: Any]) ?? msg
        let row = (data["message"] as? [String: Any]) ?? data
        let mid = Self.int64(row["id"]) ?? 0
        var cid = Self.int64(row["conversation_id"]) ?? 0
        if cid <= 0 { cid = Self.int64(data["conversation_id"]) ?? 0 }
        if mid <= 0 || cid <= 0 { bump("chat_unparsed"); return }
        let key = "\(cid):\(mid)"
        let dup = seenSet.contains(key)
        if !dup {
            seenSet.insert(key)
            seenOrder.append(key)
            if seenOrder.count > seenMax {
                let drop = seenOrder.removeFirst()
                seenSet.remove(drop)
            }
        }
        var journaled = false
        if dup {
            bump("dup")
        } else {
            let acct = authedAcct.isEmpty ? expectedAcct : authedAcct
            if let line = ChatBgJournal.lineFromSyncRow(acct: acct, cid: String(cid), m: row) {
                var out = line
                if let ld = line.data(using: .utf8),
                   var o = (try? JSONSerialization.jsonObject(with: ld)) as? [String: Any] {
                    o["src"] = "ws"
                    if let sn = row["sender_name"] as? String, !sn.isEmpty, (o["full"] as? String) == "1" { o["sname"] = sn }
                    if let od = try? JSONSerialization.data(withJSONObject: o),
                       let os = String(data: od, encoding: .utf8) { out = os }
                }
                journaled = ChatBgJournal.append([out]) > 0
                bump(journaled ? "journaled" : "journal_skip")
            }
        }
        let enriched = row["thumb_b64"] != nil || row["thumbnail_url"] != nil || row["width"] != nil
        emitFrame([
            "type": type,
            "cid": Double(cid),
            "mid": Double(mid),
            "eventId": Double(ev),
            "sender": (row["sender_email"] as? String) ?? "",
            "dup": dup,
            "enriched": enriched,
            "journaled": journaled,
            "at": Date().timeIntervalSince1970 * 1000,
        ])
    }

    private static func normEmail(_ e: String?) -> String {
        var s = (e ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasSuffix("@onemundo.com.br") {
            s = String(s.dropLast("@onemundo.com.br".count)) + "@chatyy.com.br"
        }
        return s
    }

    private static func int64(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return n.int64Value }
        if let s = v as? String { return Int64(s) }
        return nil
    }
}
