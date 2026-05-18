import UIKit
import SwiftUI
import LiveKitClient
import AVFoundation

// [Stage #999 native live broadcast, 2026-05-17]
//
// UIKit host for the SwiftUI LiveBroadcastView. Owns:
//   - The LiveKit Room (publisher role) — publishes camera + mic to the
//     `live_<sessionId>` LK room. Optional screen-share via ReplayKit
//     (#975) is wired up via setScreenShareEnabled().
//   - The WS connection that carries live_* events (live_pin_comment,
//     live_slow_mode, live_viewer_kicked, live_poll_*, live_comment,
//     live_reaction, live_cohost_approved) — talking to
//     wss://ws.chatyy.com.br/ws using the App Group bearer.
//   - The session state (LiveBroadcastSessionState) consumed by SwiftUI.
//   - Duration ticker (1 Hz) updating session.durationSeconds so the
//     top-bar shows the elapsed time.
//
// Mirror of GroupCallViewController / CallViewController:
//   - JS calls ExpoCallKit.startLiveBroadcast(liveSessionId, lkUrl,
//     lkToken, hostEmail, hostName, hostAvatar).
//   - The module finds the keyWindow root and calls
//     LiveBroadcastViewController.present(from:liveSessionId:...).
//
// LiveKit Swift 2.x API names verified against client-sdk-swift main:
//   - Room(delegate:).connect(url:token:)
//   - localParticipant.setMicrophone(enabled:)
//   - localParticipant.setCamera(enabled:)
//   - localParticipant.setScreenShareEnabled(enabled:)
//   - localParticipant.publish(data:options:) — bytes broadcast over the
//     room's data channel.

// MARK: - State

/// Pinned-comment snapshot. Mirrors the live_pin_comment WS payload —
/// authorName + text only; viewers don't need the original message id.
struct LivePinnedComment: Equatable {
    let authorName: String
    let text: String
}

/// One row in the chat overlay. `id` is whatever the server assigned
/// (msg_id) or a locally-generated UUID for outgoing messages that haven't
/// yet been echoed back over WS.
struct LiveChatMessage: Identifiable, Equatable {
    let id: String
    let authorEmail: String
    let authorName: String
    let text: String
    let isHost: Bool
    let timestamp: Date
}

/// Floating reaction emoji on top of the broadcast. SwiftUI's
/// FloatingHeart subview animates the y-translate; we just need a unique
/// id + x position + emoji to render.
struct LiveFloatingReaction: Identifiable, Equatable {
    let id: UUID
    let emoji: String
    let xOffset: CGFloat
    let spawnedAt: Date
}

/// Cohost roster entry. The host's LK Room subscribes to participants in
/// the `live_<sessionId>` room — when a viewer is approved as cohost and
/// publishes, we add a tile.
struct LiveCohost: Identifiable, Equatable {
    let id: String        // mirrors identity
    let identity: String
    let name: String
    let videoTrack: VideoTrack?

    static func == (lhs: LiveCohost, rhs: LiveCohost) -> Bool {
        guard lhs.identity == rhs.identity else { return false }
        guard lhs.name == rhs.name else { return false }
        switch (lhs.videoTrack, rhs.videoTrack) {
        case (nil, nil): return true
        case (let a?, let b?): return ObjectIdentifier(a) == ObjectIdentifier(b)
        default: return false
        }
    }
}

/// Active poll snapshot. Mirrors live-broadcast.js's activePoll state.
struct LivePoll: Equatable {
    let id: String
    let question: String
    var options: [LivePollOption]
    var totalVotes: Int
    var closed: Bool
}

struct LivePollOption: Equatable {
    let text: String
    var votes: Int
}

/// Single source of truth for LiveBroadcastView. The VC mutates these
/// fields from RoomDelegate + WS handler callbacks (always dispatched to
/// the main actor); SwiftUI re-renders the affected sub-views.
final class LiveBroadcastSessionState: ObservableObject {
    @Published var localVideoTrack: LocalVideoTrack?
    @Published var cameraStatus: String = "Conectando à câmera..."
    @Published var viewerCount: Int = 0
    @Published var durationSeconds: Int = 0
    @Published var connectionQuality: String = "good"
    @Published var pinnedComment: LivePinnedComment?
    @Published var slowModeSeconds: Int = 0
    @Published var chatMessages: [LiveChatMessage] = []
    @Published var floatingReactions: [LiveFloatingReaction] = []
    @Published var activePoll: LivePoll?
    @Published var cohosts: [LiveCohost] = []
    @Published var flashOn: Bool = false
    @Published var ended: Bool = false
}

// MARK: - ViewController

final class LiveBroadcastViewController: UIViewController {

    /// Posted when the host taps the close X or the END LIVE button. The
    /// module observes this and re-emits onCallEnded to JS so the router
    /// can navigate back. Reuses the existing ExpoCallKitNativeCallEnded
    /// name with callId = liveSessionId so the existing observer covers
    /// us with no module change.
    static let liveEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // MARK: - Params

    let liveSessionId: String
    let lkUrl: String
    let lkToken: String
    let hostEmail: String
    let hostName: String
    let hostAvatar: String?

    // MARK: - LiveKit Room

    /// Publisher room. Owns the camera+mic publish lifecycle.
    private var room: Room?
    private let session = LiveBroadcastSessionState()
    /// Front/back facing toggle. setCameraPosition is not directly exposed
    /// on LK 2.x's LocalParticipant — we hold the current state and re-
    /// publish with `setCamera(captureOptions:)` to flip.
    private var currentCameraPosition: AVCaptureDevice.Position = .front

    // MARK: - Reconnect

    private var reconnectAttempts: Int = 0
    private let maxReconnect: Int = 3
    private let reconnectBackoff: [TimeInterval] = [1, 2, 4]

    // MARK: - Duration

    private var durationTimer: Timer?
    private let startedAt: Date = Date()

    // MARK: - WS

    private var ws: URLSessionWebSocketTask?
    private var wsSession: URLSession?
    private var wsAuthed: Bool = false
    private var wsReconnectAttempts: Int = 0
    private var wsPingTimer: Timer?
    private let wsURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private let appGroupId = "group.com.onemundo.mail"

    // MARK: - Floating reactions GC timer

    private var reactionGcTimer: Timer?

    // MARK: - Init

    init(liveSessionId: String,
         lkUrl: String,
         lkToken: String,
         hostEmail: String,
         hostName: String,
         hostAvatar: String?) {
        self.liveSessionId = liveSessionId
        self.lkUrl = lkUrl
        self.lkToken = lkToken
        self.hostEmail = hostEmail
        self.hostName = hostName
        self.hostAvatar = hostAvatar
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        let rootView = LiveBroadcastView(
            session: session,
            liveSessionId: liveSessionId,
            hostName: hostName,
            hostEmail: hostEmail,
            hostAvatar: hostAvatar,
            onClose: { [weak self] in self?.handleClose(userInitiated: true) },
            onFlipCamera: { [weak self] in self?.flipCamera() },
            onToggleFlash: { [weak self] in self?.toggleFlash() },
            onOpenFilters: { [weak self] in self?.openFiltersSheet() },
            onOpenSettings: { [weak self] in self?.openSettingsSheet() },
            onEndLive: { [weak self] in self?.confirmEndLive() },
            onSendComment: { [weak self] txt in self?.sendComment(txt) },
            onSendReaction: { [weak self] emoji in self?.sendReaction(emoji) },
            onOpenPollCreator: { [weak self] in self?.openPollCreator() },
            onTapPoll: { [weak self] in self?.openPollDetails() },
            onOpenViewerList: { [weak self] in self?.openViewerList() }
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

        // Burst overlay sits on top of the SwiftUI body so reaction emojis
        // can float without re-rendering the camera fill on every tick.
        let burstView = LiveReactionBurst(session: session)
        let burstHost = UIHostingController(rootView: burstView)
        addChild(burstHost)
        burstHost.view.translatesAutoresizingMaskIntoConstraints = false
        burstHost.view.backgroundColor = .clear
        burstHost.view.isUserInteractionEnabled = false
        view.addSubview(burstHost.view)
        NSLayoutConstraint.activate([
            burstHost.view.topAnchor.constraint(equalTo: view.topAnchor),
            burstHost.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            burstHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            burstHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        burstHost.didMove(toParent: self)

        startDurationTimer()
        startReactionGc()
        connectLiveKit()
        connectWs()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - LiveKit

    private func connectLiveKit() {
        guard !lkUrl.isEmpty, !lkToken.isEmpty else {
            print("[LiveBroadcastVC] missing lkUrl/lkToken — aborting connect")
            session.cameraStatus = "Erro: credenciais ausentes"
            return
        }
        print("[LiveBroadcastVC] connecting LK — session=\(liveSessionId)")
        let r = Room(delegate: self)
        self.room = r
        Task { [weak self] in
            guard let self = self else { return }
            do {
                try await r.connect(url: self.lkUrl, token: self.lkToken)
                try await r.localParticipant.setMicrophone(enabled: true)
                let pub = try? await r.localParticipant.setCamera(enabled: true)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run {
                        self.session.localVideoTrack = track
                        self.session.cameraStatus = "Câmera ativa"
                    }
                }
                print("[LiveBroadcastVC] camera+mic published")
                self.reconnectAttempts = 0
            } catch {
                print("[LiveBroadcastVC] connect failed: \(error)")
                await MainActor.run {
                    self.session.cameraStatus = "Falha ao conectar"
                }
                self.scheduleLkReconnect()
            }
        }
    }

    private func scheduleLkReconnect() {
        guard reconnectAttempts < maxReconnect else {
            print("[LiveBroadcastVC] LK reconnect: max attempts reached")
            return
        }
        let backoff = reconnectBackoff[min(reconnectAttempts, reconnectBackoff.count - 1)]
        reconnectAttempts += 1
        print("[LiveBroadcastVC] LK reconnect: attempt \(reconnectAttempts) in \(backoff)s")
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            self?.connectLiveKit()
        }
    }

    // MARK: - WS (raw URLSessionWebSocketTask)

    /// Connect to wss://ws.chatyy.com.br/ws, send {type:auth,token:<bearer>},
    /// then subscribe to live channel by sending {type:live_subscribe,
    /// live_session_id:<id>}. Server-side already broadcasts live_* events
    /// to all subscribers of the channel.
    private func connectWs() {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let token = ud.string(forKey: "auth_token"), !token.isEmpty else {
            print("[LiveBroadcastVC] WS: no auth_token in App Group — skipping")
            return
        }
        if wsSession == nil {
            let cfg = URLSessionConfiguration.default
            cfg.waitsForConnectivity = false
            cfg.timeoutIntervalForRequest = 10
            wsSession = URLSession(configuration: cfg)
        }
        let task = wsSession!.webSocketTask(with: wsURL)
        self.ws = task
        task.resume()
        let authJson = "{\"type\":\"auth\",\"token\":\"\(escapeJSON(token))\"}"
        task.send(.string(authJson)) { [weak self] err in
            if let err = err {
                print("[LiveBroadcastVC] WS auth send failed: \(err.localizedDescription)")
                self?.scheduleWsReconnect()
            }
        }
        listenWs(on: task)
        startWsPing()
    }

    private func listenWs(on task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self = self, let task = task else { return }
            switch result {
            case .failure(let err):
                print("[LiveBroadcastVC] WS recv failure: \(err.localizedDescription)")
                self.scheduleWsReconnect()
            case .success(let msg):
                self.handleWsMessage(msg)
                self.listenWs(on: task)
            }
        }
    }

    private func handleWsMessage(_ msg: URLSessionWebSocketTask.Message) {
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
        let type = (obj["type"] as? String) ?? ""
        switch type {
        case "auth_success":
            wsAuthed = true
            wsReconnectAttempts = 0
            // Subscribe to this live's channel.
            sendWs(["type": "live_subscribe", "live_session_id": liveSessionId])
        case "live_comment":
            handleLiveComment(obj)
        case "live_reaction":
            handleLiveReaction(obj)
        case "live_pin_comment":
            handlePinComment(obj)
        case "live_slow_mode":
            handleSlowMode(obj)
        case "live_viewer_kicked":
            // No-op on the host side beyond updating local view (the host
            // just kicked them — backend echoes for parity with viewers).
            print("[LiveBroadcastVC] live_viewer_kicked echo")
        case "live_poll_created":
            handlePollCreated(obj)
        case "live_poll_voted":
            handlePollVoted(obj)
        case "live_poll_closed":
            handlePollClosed(obj)
        case "live_cohost_approved":
            // Host's own approval echoes here. Subscriber path picks up the
            // cohort's video via RoomDelegate.didSubscribeTrack below.
            print("[LiveBroadcastVC] live_cohost_approved echo")
        case "live_viewer_count":
            if let n = obj["count"] as? Int {
                Task { @MainActor [weak self] in self?.session.viewerCount = n }
            }
        default:
            break
        }
    }

    private func sendWs(_ dict: [String: Any]) {
        guard let task = ws else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { err in
            if let err = err {
                print("[LiveBroadcastVC] WS send failed: \(err.localizedDescription)")
            }
        }
    }

    private func startWsPing() {
        wsPingTimer?.invalidate()
        wsPingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            self?.ws?.sendPing { err in
                if let err = err {
                    print("[LiveBroadcastVC] WS ping failed: \(err.localizedDescription)")
                }
            }
        }
    }

    private func scheduleWsReconnect() {
        wsAuthed = false
        wsPingTimer?.invalidate()
        wsPingTimer = nil
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        guard wsReconnectAttempts < maxReconnect else {
            print("[LiveBroadcastVC] WS reconnect: max attempts reached")
            return
        }
        let backoff = reconnectBackoff[min(wsReconnectAttempts, reconnectBackoff.count - 1)]
        wsReconnectAttempts += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            self?.connectWs()
        }
    }

    private func escapeJSON(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
    }

    // MARK: - WS event handlers (main actor mutations)

    private func handleLiveComment(_ obj: [String: Any]) {
        let id = (obj["msg_id"] as? String) ?? UUID().uuidString
        let email = (obj["author_email"] as? String) ?? ""
        let name = (obj["author_name"] as? String) ?? email.split(separator: "@").first.map(String.init) ?? "?"
        let text = (obj["text"] as? String) ?? ""
        let isHost = email.lowercased() == hostEmail.lowercased()
        let msg = LiveChatMessage(
            id: id, authorEmail: email, authorName: name,
            text: text, isHost: isHost, timestamp: Date()
        )
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            var arr = self.session.chatMessages
            arr.append(msg)
            if arr.count > 50 { arr = Array(arr.suffix(50)) }
            self.session.chatMessages = arr
        }
    }

    private func handleLiveReaction(_ obj: [String: Any]) {
        let emoji = (obj["emoji"] as? String) ?? "❤️"
        let xNorm = (obj["x"] as? Double) ?? Double.random(in: 0.3...0.9)
        let screenW = UIScreen.main.bounds.width
        let xOff = CGFloat(xNorm) * screenW - screenW / 2
        let reaction = LiveFloatingReaction(
            id: UUID(), emoji: emoji, xOffset: xOff, spawnedAt: Date()
        )
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            var arr = self.session.floatingReactions
            arr.append(reaction)
            if arr.count > 20 { arr = Array(arr.suffix(20)) }
            self.session.floatingReactions = arr
        }
    }

    private func handlePinComment(_ obj: [String: Any]) {
        let text = (obj["comment_text"] as? String) ?? ""
        let name = (obj["comment_author_name"] as? String) ?? "?"
        Task { @MainActor [weak self] in
            if text.isEmpty {
                self?.session.pinnedComment = nil
            } else {
                self?.session.pinnedComment = LivePinnedComment(authorName: name, text: text)
            }
        }
    }

    private func handleSlowMode(_ obj: [String: Any]) {
        let s = (obj["seconds"] as? Int) ?? 0
        Task { @MainActor [weak self] in self?.session.slowModeSeconds = s }
    }

    private func handlePollCreated(_ obj: [String: Any]) {
        let pollObj = (obj["poll"] as? [String: Any]) ?? obj
        guard let pid = (pollObj["id"] as? String) ?? (pollObj["poll_id"] as? String) else { return }
        let question = (pollObj["question"] as? String) ?? ""
        let rawOpts = (pollObj["options"] as? [Any]) ?? []
        let options: [LivePollOption] = rawOpts.compactMap { item in
            if let s = item as? String {
                return LivePollOption(text: s, votes: 0)
            } else if let d = item as? [String: Any] {
                let txt = (d["text"] as? String) ?? ""
                let votes = (d["votes"] as? Int) ?? 0
                return LivePollOption(text: txt, votes: votes)
            }
            return nil
        }
        let total = (pollObj["total_votes"] as? Int) ?? options.reduce(0) { $0 + $1.votes }
        let closed = (pollObj["closed"] as? Bool) ?? false
        Task { @MainActor [weak self] in
            self?.session.activePoll = LivePoll(
                id: pid, question: question, options: options,
                totalVotes: total, closed: closed
            )
        }
    }

    private func handlePollVoted(_ obj: [String: Any]) {
        guard let pid = (obj["poll_id"] as? String) else { return }
        let incoming = (obj["options"] as? [Any]) ?? []
        let total = (obj["total_votes"] as? Int)
        Task { @MainActor [weak self] in
            guard let self = self, var poll = self.session.activePoll, poll.id == pid else { return }
            for (i, raw) in incoming.enumerated() where i < poll.options.count {
                if let v = raw as? Int {
                    poll.options[i].votes = v
                } else if let d = raw as? [String: Any], let v = d["votes"] as? Int {
                    poll.options[i].votes = v
                }
            }
            if let t = total { poll.totalVotes = t }
            else { poll.totalVotes = poll.options.reduce(0) { $0 + $1.votes } }
            self.session.activePoll = poll
        }
    }

    private func handlePollClosed(_ obj: [String: Any]) {
        guard let pid = (obj["poll_id"] as? String) else { return }
        Task { @MainActor [weak self] in
            guard let self = self, var poll = self.session.activePoll, poll.id == pid else { return }
            poll.closed = true
            self.session.activePoll = poll
        }
    }

    // MARK: - User actions

    private func sendComment(_ text: String) {
        sendWs([
            "type": "live_comment",
            "live_session_id": liveSessionId,
            "text": text,
            "author_email": hostEmail,
            "author_name": hostName,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ])
        // Optimistic local echo so the host sees their comment instantly.
        let msg = LiveChatMessage(
            id: "local-\(UUID().uuidString)", authorEmail: hostEmail,
            authorName: hostName, text: text, isHost: true, timestamp: Date()
        )
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            var arr = self.session.chatMessages
            arr.append(msg)
            if arr.count > 50 { arr = Array(arr.suffix(50)) }
            self.session.chatMessages = arr
        }
    }

    private func sendReaction(_ emoji: String) {
        let x = Double.random(in: 0.4...0.9)
        sendWs([
            "type": "live_reaction",
            "live_session_id": liveSessionId,
            "emoji": emoji,
            "x": x,
            "reactor_email": hostEmail,
            "reactor_name": hostName,
        ])
        // Locally spawn so the host sees their own burst.
        handleLiveReaction(["emoji": emoji, "x": x])
        // Also publish over LK data channel so subscribers without WS
        // (network-degraded viewers) still get the burst — broadcast is
        // unreliable & ordered=false to keep latency low.
        if let r = self.room {
            let payload = "{\"type\":\"reaction\",\"emoji\":\"\(emoji)\",\"x\":\(x)}"
            if let data = payload.data(using: .utf8) {
                Task {
                    do {
                        try await r.localParticipant.publish(data: data, options: nil)
                    } catch {
                        print("[LiveBroadcastVC] publishData reaction failed: \(error)")
                    }
                }
            }
        }
    }

    private func flipCamera() {
        guard let r = self.room else { return }
        let next: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
        currentCameraPosition = next
        Task { [weak self] in
            guard let self = self else { return }
            // LK 2.x exposes setCamera(captureOptions:) on LocalParticipant.
            // We rebuild CameraCaptureOptions with the new position. If the
            // API signature shifts in a minor SDK rev, fall back to disable+
            // re-enable which forces a fresh capturer.
            do {
                let opts = CameraCaptureOptions(position: next)
                let pub = try await r.localParticipant.setCamera(enabled: true, captureOptions: opts)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.session.localVideoTrack = track }
                }
            } catch {
                print("[LiveBroadcastVC] flipCamera failed: \(error) — falling back to disable/enable")
                _ = try? await r.localParticipant.setCamera(enabled: false)
                let pub = try? await r.localParticipant.setCamera(enabled: true)
                if let track = pub?.track as? LocalVideoTrack {
                    await MainActor.run { self.session.localVideoTrack = track }
                }
            }
        }
    }

    private func toggleFlash() {
        // Flash is on the back camera only. AVCaptureDevice torch — we
        // don't own the AVCaptureSession (LK does), so this is a best-
        // effort toggle on the default video device.
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else {
            print("[LiveBroadcastVC] flash: no torch on device")
            return
        }
        let want = !session.flashOn
        do {
            try device.lockForConfiguration()
            device.torchMode = want ? .on : .off
            device.unlockForConfiguration()
            Task { @MainActor [weak self] in self?.session.flashOn = want }
        } catch {
            print("[LiveBroadcastVC] flash toggle failed: \(error)")
        }
    }

    private func openFiltersSheet() {
        let alert = UIAlertController(
            title: "Filtros",
            message: "Filtros de câmera serão liberados em breve.",
            preferredStyle: .actionSheet
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private func openSettingsSheet() {
        let alert = UIAlertController(
            title: "Configurações da Live",
            message: nil,
            preferredStyle: .actionSheet
        )
        // Slow mode picker.
        for sec in [0, 5, 15, 30, 60] {
            let label = sec == 0 ? "Modo lento: desligado" : "Modo lento: \(sec)s"
            alert.addAction(UIAlertAction(title: label, style: .default) { [weak self] _ in
                self?.applySlowMode(sec)
            })
        }
        alert.addAction(UIAlertAction(title: "Lista de espectadores", style: .default) { [weak self] _ in
            self?.openViewerList()
        })
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel))
        present(alert, animated: true)
    }

    private func applySlowMode(_ seconds: Int) {
        sendWs([
            "type": "live_slow_mode",
            "live_session_id": liveSessionId,
            "seconds": seconds,
        ])
        Task { @MainActor [weak self] in self?.session.slowModeSeconds = seconds }
    }

    private func openViewerList() {
        // Minimal placeholder — full sheet with long-press → ban/kick is a
        // follow-up. The Settings sheet currently exposes slow mode only.
        let alert = UIAlertController(
            title: "Espectadores",
            message: "\(session.viewerCount) assistindo",
            preferredStyle: .actionSheet
        )
        alert.addAction(UIAlertAction(title: "Fechar", style: .cancel))
        present(alert, animated: true)
    }

    private func confirmEndLive() {
        let alert = UIAlertController(
            title: "Encerrar live?",
            message: "Os espectadores serão desconectados.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel))
        alert.addAction(UIAlertAction(title: "Encerrar", style: .destructive) { [weak self] _ in
            self?.handleClose(userInitiated: true)
        })
        present(alert, animated: true)
    }

    private func openPollCreator() {
        let alert = UIAlertController(
            title: "Nova enquete",
            message: "Digite a pergunta e até 4 opções.",
            preferredStyle: .alert
        )
        alert.addTextField { tf in tf.placeholder = "Pergunta" }
        for i in 1...4 {
            alert.addTextField { tf in tf.placeholder = "Opção \(i)" }
        }
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel))
        alert.addAction(UIAlertAction(title: "Criar", style: .default) { [weak self] _ in
            guard let self = self else { return }
            let q = alert.textFields?.first?.text ?? ""
            let opts = (alert.textFields ?? []).dropFirst().compactMap { $0.text }
                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            guard !q.isEmpty, !opts.isEmpty else { return }
            self.sendWs([
                "type": "live_poll_create",
                "live_session_id": self.liveSessionId,
                "question": q,
                "options": Array(opts),
            ])
        })
        present(alert, animated: true)
    }

    private func openPollDetails() {
        guard let poll = session.activePoll else { return }
        let total = max(poll.totalVotes, 1)
        var body = ""
        for opt in poll.options {
            let pct = Double(opt.votes) * 100.0 / Double(total)
            body += "\(opt.text) — \(opt.votes) (\(Int(pct))%)\n"
        }
        let alert = UIAlertController(
            title: poll.question,
            message: body,
            preferredStyle: .actionSheet
        )
        if !poll.closed {
            alert.addAction(UIAlertAction(title: "Encerrar enquete", style: .destructive) { [weak self] _ in
                self?.sendWs([
                    "type": "live_poll_close",
                    "live_session_id": self?.liveSessionId ?? "",
                    "poll_id": poll.id,
                ])
            })
        }
        alert.addAction(UIAlertAction(title: "Fechar", style: .cancel))
        present(alert, animated: true)
    }

    private func handleClose(userInitiated: Bool) {
        guard !session.ended else { return }
        session.ended = true
        // Notify module → JS via NotificationCenter.
        NotificationCenter.default.post(
            name: LiveBroadcastViewController.liveEndedNotification,
            object: nil,
            userInfo: ["callId": liveSessionId]
        )
        sendWs([
            "type": "live_end",
            "live_session_id": liveSessionId,
        ])
        if let r = self.room {
            self.room = nil
            Task { await r.disconnect() }
        }
        ws?.cancel(with: .normalClosure, reason: nil)
        ws = nil
        wsPingTimer?.invalidate()
        wsPingTimer = nil
        durationTimer?.invalidate()
        durationTimer = nil
        reactionGcTimer?.invalidate()
        reactionGcTimer = nil
        dismiss(animated: true, completion: nil)
    }

    // MARK: - Duration ticker

    private func startDurationTimer() {
        durationTimer?.invalidate()
        durationTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let elapsed = Int(Date().timeIntervalSince(self.startedAt))
            self.session.durationSeconds = elapsed
        }
    }

    // MARK: - Reaction GC

    /// Reaping the floatingReactions array so SwiftUI's ForEach stays
    /// small. FloatingHeart animates over 2.6s; we GC every 3s.
    private func startReactionGc() {
        reactionGcTimer?.invalidate()
        reactionGcTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let cutoff = Date().addingTimeInterval(-3.0)
            let next = self.session.floatingReactions.filter { $0.spawnedAt > cutoff }
            if next.count != self.session.floatingReactions.count {
                self.session.floatingReactions = next
            }
        }
    }

    // MARK: - Screen share (#975 ReplayKit)

    /// Toggle screen-share via LK's built-in setScreenShareEnabled. This
    /// triggers the system broadcast picker (RPSystemBroadcastPickerView
    /// internally), and ChatyyBroadcastExtension handles the frames.
    /// Currently unused by the SwiftUI body — left here so the bridge
    /// has a hook once we add the toggle to the Settings sheet.
    func toggleScreenShare(enabled: Bool) {
        guard let r = self.room else { return }
        Task {
            do {
                // LiveKit Swift SDK: setScreenShareEnabled was renamed to
                // set(source:enabled:). Use the new API.
                _ = try await r.localParticipant.set(source: .screenShareVideo, enabled: enabled)
                print("[LiveBroadcastVC] screen share \(enabled ? "on" : "off")")
            } catch {
                print("[LiveBroadcastVC] set(.screenShareVideo, enabled: \(enabled)) failed: \(error)")
            }
        }
    }

    // MARK: - Deinit

    deinit {
        durationTimer?.invalidate()
        reactionGcTimer?.invalidate()
        wsPingTimer?.invalidate()
        ws?.cancel(with: .goingAway, reason: nil)
        if let r = self.room {
            Task { await r.disconnect() }
        }
    }

    // MARK: - Presentation

    static func present(from base: UIViewController,
                        liveSessionId: String,
                        lkUrl: String,
                        lkToken: String,
                        hostEmail: String,
                        hostName: String,
                        hostAvatar: String?) {
        let top = topMostViewController(from: base)
        let vc = LiveBroadcastViewController(
            liveSessionId: liveSessionId,
            lkUrl: lkUrl,
            lkToken: lkToken,
            hostEmail: hostEmail,
            hostName: hostName,
            hostAvatar: hostAvatar
        )
        top.present(vc, animated: true, completion: nil)
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

extension LiveBroadcastViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[LiveBroadcastVC] roomDidConnect")
        Task { @MainActor [weak self] in
            self?.session.cameraStatus = "Câmera ativa"
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[LiveBroadcastVC] didDisconnectWithError: \(String(describing: error))")
        Task { @MainActor [weak self] in
            self?.session.cameraStatus = "Desconectado"
        }
        // Don't auto-end — try to reconnect first.
        scheduleLkReconnect()
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        // A cohost joined the room (approved viewer subscribing). We render
        // a placeholder tile until didSubscribeTrack hands us the video.
        let identity = participant.identity?.stringValue ?? "?"
        let name = participant.name ?? identity
        let cohost = LiveCohost(id: "ch:\(identity)", identity: identity, name: name, videoTrack: nil)
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            var arr = self.session.cohosts
            if !arr.contains(where: { $0.identity == identity }) {
                arr.append(cohost)
                self.session.cohosts = arr
            }
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? "?"
        Task { @MainActor [weak self] in
            self?.session.cohosts.removeAll { $0.identity == identity }
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else { return }
        let identity = participant.identity?.stringValue ?? "?"
        let name = participant.name ?? identity
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            var arr = self.session.cohosts
            if let idx = arr.firstIndex(where: { $0.identity == identity }) {
                let cur = arr[idx]
                arr[idx] = LiveCohost(id: cur.id, identity: cur.identity, name: cur.name, videoTrack: track)
            } else {
                arr.append(LiveCohost(id: "ch:\(identity)", identity: identity, name: name, videoTrack: track))
            }
            self.session.cohosts = arr
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        let identity = participant.identity?.stringValue ?? "?"
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if let idx = self.session.cohosts.firstIndex(where: { $0.identity == identity }) {
                let cur = self.session.cohosts[idx]
                self.session.cohosts[idx] = LiveCohost(id: cur.id, identity: cur.identity, name: cur.name, videoTrack: nil)
            }
        }
    }

    /// LK data channel — viewers send {type:"reaction",emoji,x} via
    /// localParticipant.publish(data:), which we mirror locally so the
    /// host sees the burst without the WS round-trip.
    func room(_ room: Room,
              participant: RemoteParticipant?,
              didReceiveData data: Data,
              forTopic topic: String?) {
        guard let s = String(data: data, encoding: .utf8),
              let raw = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            return
        }
        let t = (obj["type"] as? String) ?? ""
        if t == "reaction" {
            handleLiveReaction(obj)
        }
    }

    /// Connection quality changes from any participant. We only care about
    /// the local one (drives the connectionBars in the top bar).
    func room(_ room: Room,
              participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        guard participant.identity == room.localParticipant.identity else { return }
        let q: String
        switch quality {
        case .excellent: q = "excellent"
        case .good:      q = "good"
        case .poor:      q = "poor"
        default:         q = "lost"
        }
        Task { @MainActor [weak self] in self?.session.connectionQuality = q }
    }
}
