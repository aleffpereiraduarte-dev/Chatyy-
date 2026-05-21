import Foundation
import CallKit

/**
 * [2026-05-16 native call signaling] CallSignalWs (iOS)
 *
 * Mirror of CallSignalWs.kt — raw URLSessionWebSocketTask to
 * wss://ws.chatyy.com.br/ws used to fire call_invite / call_answered /
 * call_end without bouncing through the JS bridge.
 *
 * Stage 1 (this file) stands up the WS plumbing and a JS-callable bridge in
 * ExpoCallKitModule. Stage 2 (separate work) will have CallViewController
 * call these directly. Until then, the JS-side WS (services/api.js) remains
 * the primary path; this is exposed for opt-in callers.
 *
 * iOS support: URLSessionWebSocketTask is iOS 13+. Module deployment target
 * is iOS 15.1 (see ExpoCallKit.podspec) so we're well in range. No new pod
 * dependency — URLSession is built-in to Foundation.
 *
 * Lifecycle
 * ---------
 *  * Lazy: nothing happens until a fire*() call arrives.
 *  * On first fire we open the WS, send {type:"auth", token:<bearer>}, wait
 *    for {type:"auth_success"}, then drain the message queue.
 *  * Subsequent fires reuse the warm WS.
 *  * If a fire arrives before auth_success completes, the JSON is queued
 *    (cap 64, oldest dropped) and shipped on drain.
 *  * Disconnect (server close, network drop) triggers reconnect with
 *    backoff: 1s → 2s → 4s, max 3 attempts. After 3 failures we give up;
 *    the next fire resets the counter. JS-side WS keeps working as fallback.
 *  * 25s ping interval via a repeating Timer (URLSessionWebSocketTask has
 *    `sendPing(pongReceiveHandler:)` and we use it to keep NAT alive — Apple
 *    doesn't auto-ping WS tasks).
 *
 * Token rotation
 * --------------
 * The bearer is read from the App Group UserDefaults on every (re)connect.
 * JS persists fresh creds via persistAuthForNativeCall on login. If the
 * App Group is empty we silently no-op so JS fallback handles it.
 *
 * Threading
 * ---------
 * All work is funneled onto a serial DispatchQueue so the public fire*()
 * methods never block. Callers can be on any thread.
 */
final class CallSignalWs: NSObject {

    static let shared = CallSignalWs()

    // MARK: – Tunables
    private let kAppGroupId = "group.com.onemundo.mail"
    private let kWsURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private let pingInterval: TimeInterval = 25
    private let authTimeout: TimeInterval = 5
    private let maxQueue = 64
    private let maxReconnect = 3
    private let backoffSec: [TimeInterval] = [1, 2, 4]

    // MARK: – State (serial queue protected)
    private let queue = DispatchQueue(label: "com.onemundo.callkit.signalws")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var authed: Bool = false
    private var connecting: Bool = false
    private var pendingMessages: [String] = []
    private var reconnectAttempts: Int = 0
    private var authTimeoutWorkItem: DispatchWorkItem?
    private var pingTimer: DispatchSourceTimer?

    // [P0 2026-05-18 #1132] Track inbound call_invite IDs we've already
    // surfaced to CallKit so a re-deliver (server retry, multi-device fan-out)
    // doesn't ring twice. Bounded — 32 entries, FIFO eviction.
    private var seenIncomingInvites: [String] = []
    private let kSeenInvitesMax = 32

    // [#1179 cleanup, 2026-05-19] Map of native-surfaced callId → CallKit UUID.
    // Populated when we report an inbound invite to CallKit; consumed when an
    // inbound call_end frame arrives so we can dismiss the matching CallKit
    // entry via reportCall(with:endedAt:reason:). Bounded — 16 entries (FIFO).
    private var inviteUUIDsByCallId: [(callId: String, uuid: UUID)] = []
    private let kInviteUUIDMax = 16

    // [P0 2026-05-18 #1132] When true, the WS stays connected even with an
    // empty outgoing queue, so inbound `call_invite` frames can be received
    // by the callee (who has nothing to send). Flipped on by `warmConnect()`.
    private var keepAlive: Bool = false

    private override init() { super.init() }

    // MARK: – Public API

    func fireCallInvite(callId: String, conversationId: String, calleeEmail: String, hasVideo: Bool) {
        // [P0 regression 2026-05-18 #1122] Server (chatyy-ws-go handleCallInvite)
        // routes the call by reading `target_email`. Emitting `callee_email`
        // alone caused the server to discard the message and the callee was
        // never rung. Always emit `target_email`; keep `callee_email` for
        // older servers.
        let dict: [String: Any] = [
            "type": "call_invite",
            "conversation_id": conversationId,
            "call_id": callId,
            "target_email": calleeEmail,
            "callee_email": calleeEmail,
            "video": hasVideo,
            "has_video": hasVideo,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ]
        // [CALL-TRACE 2026-05-20 WAVE42] Step 4/12 — caller pushes call_invite
        // into the iOS native WS outbox.
        NSLog("[CallTrace][4/12] WS send call_invite callId=\(callId) callee=\(calleeEmail) video=\(hasVideo) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        enqueue(dict)
    }

    func fireCallAnswered(callId: String, conversationId: String) {
        let dict: [String: Any] = [
            "type": "call_answered",
            "call_id": callId,
            "conversation_id": conversationId,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ]
        enqueue(dict)
    }

    func fireCallEnd(callId: String, conversationId: String, reason: String) {
        let dict: [String: Any] = [
            "type": "call_end",
            "call_id": callId,
            "conversation_id": conversationId,
            "reason": reason,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ]
        enqueue(dict)
    }

    /// [reaction bar, 2026-05-17] Floating-emoji reaction during an active
    /// call. Mirrors the status-reaction WS event so the same broadcaster
    /// hub fans it to all peers in the same conversation. The LK DataPacket
    /// path (CallViewController.sendReaction) stays — both fire so reactions
    /// arrive even when one transport is briefly down.
    func fireCallReaction(callId: String, conversationId: String, emoji: String) {
        let dict: [String: Any] = [
            "type": "call_reaction",
            "call_id": callId,
            "conversation_id": conversationId,
            "emoji": emoji,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        enqueue(dict)
    }

    // MARK: – Internals

    private func enqueue(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return }
        queue.async { [weak self] in
            guard let self = self else { return }
            // Bound the queue; drop oldest if we accumulate.
            while self.pendingMessages.count >= self.maxQueue {
                self.pendingMessages.removeFirst()
            }
            self.pendingMessages.append(s)
            self.tryFlushLocked()
        }
    }

    /// [P0 2026-05-18 #1132] Open the WS now (if not already open) and keep it
    /// open across reconnects so inbound `call_invite` frames can ring CallKit.
    /// JS should call this after login + on app foreground. Idempotent.
    func warmConnect() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.keepAlive = true
            if self.authed { return }
            if self.connecting { return }
            self.reconnectAttempts = 0
            self.connectLocked()
        }
    }

    /// Called on `queue`.
    private func tryFlushLocked() {
        if authed { drainLocked(); return }
        if connecting { return }
        // Fresh fire — reset attempts so we retry even if a previous burst
        // gave up.
        reconnectAttempts = 0
        connectLocked()
    }

    /// Called on `queue`.
    private func connectLocked() {
        guard !connecting else { return }
        guard let ud = UserDefaults(suiteName: kAppGroupId),
              let token = ud.string(forKey: "auth_token"), !token.isEmpty else {
            NSLog("[CallSignalWs] connect: no auth_token in App Group — skipping (JS fallback will fire)")
            return
        }
        connecting = true

        if session == nil {
            let cfg = URLSessionConfiguration.default
            cfg.waitsForConnectivity = false
            cfg.timeoutIntervalForRequest = 10
            session = URLSession(configuration: cfg, delegate: nil, delegateQueue: nil)
        }

        let newTask = session!.webSocketTask(with: kWsURL)
        task = newTask
        newTask.resume()

        // Send auth immediately. URLSessionWebSocketTask buffers the send
        // until the handshake completes — Apple doesn't expose an onOpen
        // hook so this is the canonical pattern.
        let authMsg = "{\"type\":\"auth\",\"token\":\"\(escapeJSON(token))\"}"
        newTask.send(.string(authMsg)) { [weak self] err in
            if let err = err {
                NSLog("[CallSignalWs] auth send failed: \(err.localizedDescription)")
                self?.queue.async { self?.onDisconnectLocked() }
            }
        }

        // Auth timeout — if auth_success doesn't arrive in time, give up
        // and reconnect (or fall through to JS-side WS).
        authTimeoutWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.queue.async {
                if !self.authed {
                    NSLog("[CallSignalWs] auth timeout — closing")
                    self.task?.cancel(with: .normalClosure, reason: nil)
                    self.onDisconnectLocked()
                }
            }
        }
        authTimeoutWorkItem = work
        queue.asyncAfter(deadline: .now() + authTimeout, execute: work)

        listenLocked(on: newTask)
    }

    /// Recursive receive loop on the task. URLSessionWebSocketTask requires
    /// you to call `receive` again after each frame — there's no continuous
    /// stream API.
    private func listenLocked(on task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self = self, let task = task else { return }
            switch result {
            case .failure(let err):
                NSLog("[CallSignalWs] receive failure: \(err.localizedDescription)")
                self.queue.async { self.onDisconnectLocked() }
            case .success(let msg):
                self.queue.async { self.handleFrameLocked(msg) }
                self.listenLocked(on: task) // re-arm
            }
        }
    }

    /// Called on `queue`.
    private func handleFrameLocked(_ msg: URLSessionWebSocketTask.Message) {
        let text: String?
        switch msg {
        case .string(let s): text = s
        case .data(let d): text = String(data: d, encoding: .utf8)
        @unknown default: text = nil
        }
        guard let t = text,
              let data = t.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let type = obj["type"] as? String ?? ""
        switch type {
        case "auth_success":
            NSLog("[CallSignalWs] auth_success — draining \(pendingMessages.count) queued frame(s)")
            authed = true
            connecting = false
            reconnectAttempts = 0
            authTimeoutWorkItem?.cancel()
            authTimeoutWorkItem = nil
            startPingTimerLocked()
            drainLocked()
        case "error":
            NSLog("[CallSignalWs] WS error frame: \(t)")
        case "call_invite":
            // [P0 2026-05-18 #1132] Native CallKit fallback for INCOMING calls.
            //
            // Before: only the JS WS (services/websocket.js) handled inbound
            // `call_invite` frames. If JS was paused, lazy-loaded, or
            // short-circuited (stale callRef / handlingRef), the modal never
            // showed and the user heard nothing — even though the server
            // delivered the frame and our raw WS task received it.
            //
            // Now: when a `call_invite` frame lands here, we report it to
            // CallKit directly via the early CXProvider (the same one VoIP
            // pushes use), then post `ExpoCallKitPendingVoipCall` so
            // ExpoCallKitModule.adoptPendingCall registers it in activeCalls
            // + emits `onIncomingCall` to JS. This is belt-and-suspenders:
            // CallKit rings even if JS is broken, and JS still gets the
            // event for its in-app modal.
            handleIncomingCallInviteLocked(obj)
        case "call_end":
            // [#1179 cleanup, 2026-05-19] Native CallKit fallback for REMOTE
            // hangup. Mirror of the Android path in CallSignalWs.kt.
            //
            // Before: only the JS WS (services/websocket.js) handled inbound
            // `call_end` frames. If JS was paused (CPU-throttled background,
            // AppState lag) the CallKit UI stayed up — user kept seeing
            // "Calling..." even though the peer had ended. Worse: when this
            // raced with the foreground CallViewController, LK Room stayed
            // connected, draining mic + data.
            //
            // Now: when a `call_end` frame lands here, we forward it via the
            // CallKit provider (earlyProvider or shared module.provider) and
            // also post `ExpoCallKitNativeCallEnded` so any active
            // CallViewController dismisses (it observes the same notification
            // via CallViewController.callEndedNotification). JS still has its
            // own `mailWs.on('call_end')` subscription — this is belt-and-
            // suspenders for the native UI cleanup.
            handleIncomingCallEndLocked(obj)
        default:
            // We don't consume any other server frames here; the JS WS owns
            // the real call event surface.
            break
        }
    }

    /// [#1179 cleanup, 2026-05-19] Called on `queue`. Native CallKit cleanup
    /// for inbound `call_end`. Reports the end to CallKit (so the system UI
    /// dismisses) and posts a notification that CallViewController observes
    /// to dismiss the in-app call screen.
    private func handleIncomingCallEndLocked(_ obj: [String: Any]) {
        let callId = (obj["call_id"] as? String) ?? (obj["room_id"] as? String) ?? ""
        let reason = (obj["reason"] as? String) ?? "remote_hangup"
        guard !callId.isEmpty else {
            NSLog("[CallSignalWs] call_end: missing call_id/room_id, skipping")
            return
        }
        NSLog("[CallSignalWs] call_end \(callId) reason=\(reason) — dismissing native call UI")

        // Drop the dedup entry so a follow-up invite with the same id (rare,
        // but possible across server reconnects) is not silently filtered.
        if let idx = seenIncomingInvites.firstIndex(of: callId) {
            seenIncomingInvites.remove(at: idx)
        }

        // Pop the matching UUID we stashed when we reported this call to
        // CallKit. If absent, the call was likely surfaced via the VoIP
        // push path (different code path that also reports to CallKit but
        // we don't have its UUID here). In that case the JS WS handler will
        // still fire ExpoCallKit.endCall(callId), which performs the
        // CXEndCallAction on the module's tracked UUID.
        var stashedUUID: UUID? = nil
        if let idx = inviteUUIDsByCallId.firstIndex(where: { $0.callId == callId }) {
            stashedUUID = inviteUUIDsByCallId[idx].uuid
            inviteUUIDsByCallId.remove(at: idx)
        }
        // [#1184 dismiss fix, 2026-05-19] Fall back to the module's shared
        // map. inviteUUIDsByCallId only tracks invites this class itself
        // surfaced to CallKit (WS-fast-path); for incoming via PushKit
        // (VoipPushAppDelegateSubscriber) and answered/outgoing calls
        // (ExpoCallKitModule.startOutgoingCall), the UUID lives in
        // ExpoCallKitModule.activeCalls instead. Without this fallback the
        // CallKit system pill/lock-screen UI stayed visible after the peer
        // hung up because we never called reportCall(...:.remoteEnded) on
        // its UUID — root cause of the "tela nativa fica aberta" bug.
        if stashedUUID == nil {
            stashedUUID = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId)
            if stashedUUID != nil {
                NSLog("[CallSignalWs] call_end \(callId) UUID via shared map fallback")
            }
        }

        // Hop to main: CallKit and NotificationCenter posts must run on main.
        DispatchQueue.main.async {
            // 1. Post the native call-ended notification. ExpoCallKitModule
            //    installs an observer that forwards this to JS as
            //    `onCallEnded`; JS-side IncomingCallListener then invokes
            //    ExpoCallKit.endCall(callId) which performs CXEndCallAction
            //    on the active CallKit UUID, which in turn drives both the
            //    CallKit system UI dismissal and (when present) the
            //    CallViewController dismiss path via its own observer.
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitNativeCallEnded"),
                object: nil,
                userInfo: ["callId": callId, "reason": reason]
            )

            // 2. If CallKit is currently showing this call (incoming RING
            //    that the user hasn't answered yet, or active call), report
            //    the remote end so the system UI dismisses. We use the early
            //    provider because it's installed before the module is loaded
            //    in the cold-start path; the live module's provider takes
            //    over once RN finishes loading and adopts pending calls.
            if let uuid = stashedUUID,
               let provider = VoipPushAppDelegateSubscriber.earlyProvider {
                provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            }
        }
    }

    /// Called on `queue`. Reports an inbound `call_invite` WS frame to CallKit
    /// and notifies ExpoCallKitModule so JS sees `onIncomingCall`.
    private func handleIncomingCallInviteLocked(_ obj: [String: Any]) {
        let callId = (obj["call_id"] as? String) ?? (obj["room_id"] as? String) ?? ""
        guard !callId.isEmpty else {
            NSLog("[CallSignalWs] call_invite: missing call_id/room_id, skipping")
            return
        }
        // Dedup: if we've already surfaced this callId in the recent window,
        // skip. Covers server retries, multi-device fan-out, and the VoIP
        // push path racing the WS frame (VoIP push fires earliest on cold
        // start, so by the time the WS frame lands the call is already up).
        if seenIncomingInvites.contains(callId) {
            NSLog("[CallSignalWs] call_invite \(callId): already surfaced, skipping")
            return
        }
        seenIncomingInvites.append(callId)
        while seenIncomingInvites.count > kSeenInvitesMax {
            seenIncomingInvites.removeFirst()
        }

        let callerEmail = (obj["caller_email"] as? String) ?? ""
        let callerName = (obj["caller_name"] as? String) ?? callerEmail
        let conversationId: String = {
            if let s = obj["conversation_id"] as? String { return s }
            if let n = obj["conversation_id"] as? NSNumber { return n.stringValue }
            return ""
        }()
        // [CALL-TRACE 2026-05-20 WAVE42] Step 6/12 — callee picks up call_invite
        // off the WS.
        NSLog("[CallTrace][6/12] WS recv call_invite callId=\(callId) fromCallerEmail=\(callerEmail) conv=\(conversationId) ts=\(Int(Date().timeIntervalSince1970 * 1000))")
        let hasVideo: Bool = {
            if let b = obj["video"] as? Bool { return b }
            if let b = obj["has_video"] as? Bool { return b }
            if let n = obj["video"] as? NSNumber { return n.boolValue }
            if let s = obj["video"] as? String { return s == "1" || s == "true" }
            return false
        }()

        // Skip self-echo: server should never deliver our own invite back,
        // but harden anyway.
        if !callerEmail.isEmpty,
           let ud = UserDefaults(suiteName: kAppGroupId),
           let selfEmail = ud.string(forKey: "user_email")?.lowercased(),
           callerEmail.lowercased() == selfEmail {
            NSLog("[CallSignalWs] call_invite \(callId): self-echo, skipping")
            return
        }

        NSLog("[CallSignalWs] call_invite \(callId) from \(callerEmail) — reporting to CallKit")
        let uuid = UUID()
        // [#1179 cleanup, 2026-05-19] Remember the UUID so a later inbound
        // call_end frame can dismiss the matching CallKit entry. FIFO trim.
        inviteUUIDsByCallId.append((callId: callId, uuid: uuid))
        while inviteUUIDsByCallId.count > kInviteUUIDMax {
            inviteUUIDsByCallId.removeFirst()
        }

        // 1. Report to CallKit FIRST (Apple deadline is paranoid; mirror the
        //    PushKit ordering). Hop to main — CXProvider should be touched on
        //    main thread.
        DispatchQueue.main.async {
            // earlyProvider is installed in VoipPushAppDelegateSubscriber's
            // didFinishLaunching path, so it's available before any WS frame
            // can arrive (WS auth requires a token persisted by JS *after*
            // app launch). Skip silently if missing — JS WS path is still
            // the primary fallback.
            guard let provider = VoipPushAppDelegateSubscriber.earlyProvider else {
                NSLog("[CallSignalWs] call_invite \(callId): earlyProvider not ready — JS path will handle")
                return
            }
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .generic, value: callerName.isEmpty ? "Chatyy" : callerName)
            update.localizedCallerName = callerName.isEmpty ? "Chatyy" : callerName
            update.hasVideo = hasVideo
            update.supportsGrouping = false
            update.supportsUngrouping = false
            update.supportsHolding = true
            update.supportsDTMF = false
            provider.reportNewIncomingCall(with: uuid, update: update) { error in
                if let error = error {
                    NSLog("[CallSignalWs] reportNewIncomingCall failed: \(error.localizedDescription)")
                } else {
                    NSLog("[CallSignalWs] reportNewIncomingCall succeeded for \(callId)")
                }
            }

            // 2. Notify ExpoCallKitModule so it tracks the call + emits
            //    `onIncomingCall` to JS (which populates callStateRef in the
            //    IncomingCallListener). Mirrors the VoIP push path.
            let payload: [String: Any] = [
                "caller_email": callerEmail,
                "caller_name": callerName,
                "conversation_id": conversationId,
                "video": hasVideo,
                "call_id": callId,
            ]
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitPendingVoipCall"),
                object: nil,
                userInfo: [
                    "callId": callId,
                    "uuid": uuid.uuidString,
                    "callerName": callerName,
                    "hasVideo": hasVideo,
                    "payload": payload,
                ]
            )
        }
    }

    /// Called on `queue`.
    private func drainLocked() {
        guard let task = task, authed else { return }
        while !pendingMessages.isEmpty {
            let msg = pendingMessages.removeFirst()
            task.send(.string(msg)) { [weak self] err in
                if let err = err {
                    NSLog("[CallSignalWs] send failed: \(err.localizedDescription)")
                    // Best-effort: put it back at the tail. Next reconnect
                    // attempt will retry.
                    self?.queue.async {
                        self?.pendingMessages.append(msg)
                        self?.onDisconnectLocked()
                    }
                }
            }
        }
    }

    /// Called on `queue`.
    private func onDisconnectLocked() {
        authed = false
        connecting = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        authTimeoutWorkItem?.cancel()
        authTimeoutWorkItem = nil
        pingTimer?.cancel()
        pingTimer = nil
        scheduleReconnectLocked()
    }

    /// Called on `queue`.
    private func scheduleReconnectLocked() {
        // Idle: stop reconnecting unless we're in keep-alive mode (callee
        // path — needs to receive inbound call_invite frames even with an
        // empty outgoing queue).
        guard !pendingMessages.isEmpty || keepAlive else { return }
        let attempt = reconnectAttempts
        reconnectAttempts += 1
        if attempt >= maxReconnect {
            // In keep-alive mode we don't give up forever — try again every
            // 30s. The JS WS is still the primary path; this is the native
            // ring fallback for inbound call_invite.
            if keepAlive {
                NSLog("[CallSignalWs] keep-alive: \(maxReconnect) attempts spent — slow retry in 30s")
                reconnectAttempts = 0
                queue.asyncAfter(deadline: .now() + 30) { [weak self] in
                    self?.connectLocked()
                }
                return
            }
            NSLog("[CallSignalWs] reconnect: gave up after \(maxReconnect) attempts — JS WS is the fallback")
            return
        }
        let backoff = backoffSec[min(attempt, backoffSec.count - 1)]
        NSLog("[CallSignalWs] reconnect: attempt \(attempt + 1)/\(maxReconnect) in \(backoff)s")
        queue.asyncAfter(deadline: .now() + backoff) { [weak self] in
            self?.connectLocked()
        }
    }

    /// Called on `queue`.
    private func startPingTimerLocked() {
        pingTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        t.setEventHandler { [weak self] in
            guard let self = self, let task = self.task, self.authed else { return }
            task.sendPing { err in
                if let err = err {
                    NSLog("[CallSignalWs] ping failed: \(err.localizedDescription)")
                    self.queue.async { self.onDisconnectLocked() }
                }
            }
        }
        t.resume()
        pingTimer = t
    }

    private func escapeJSON(_ s: String) -> String {
        // Minimal escape for the inline auth payload — the bearer is a
        // base64url string in practice so this is paranoia.
        return s.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
    }
}
