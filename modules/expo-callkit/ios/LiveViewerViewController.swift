import UIKit
import SwiftUI
import LiveKitClient
import AVKit

// [Stage #1000 native live viewer, 2026-05-17]
//
// UIKit host for the SwiftUI LiveViewerView. Owns:
//   - The LiveKit Room (subscriber-only role) — subscribes to the host's
//     camera/mic in the `live_<sessionId>` LK room. No publish unless the
//     user is approved as a cohost (separate stage).
//   - The WS connection consuming live_* events (live_pin_comment,
//     live_slow_mode, live_viewer_kicked, live_poll_*, live_comment,
//     live_reaction, live_cohost_approved).
//   - The session state (LiveViewerSessionState) consumed by SwiftUI.
//   - The auto-hangup path on live_viewer_kicked.
//
// Mirror of LiveBroadcastViewController but with publish disabled. JS
// calls ExpoCallKit.startLiveViewer(liveSessionId, lkUrl, lkToken,
// hostEmail, hostName, hostAvatar, pinnedComment, slowModeSeconds).
//
// LiveKit Swift 2.x API names:
//   - Room(delegate:).connect(url:token:)
//   - participant.publish(data:options:) for reactions (when cohost)
//   - VideoTrack from RemoteTrackPublication when kind == .video
//
// PiP (optional, nice-to-have): wiring deferred per the CallViewController
// notes (LK Swift 2.x does not publicly expose CMSampleBuffer frames for
// VideoTrack — same blocker as the call PiP). The flag `pipController`
// stays nil; AVPictureInPictureController lifecycle hooks are scaffolded
// so a future round can land it without restructuring.

final class LiveViewerSessionState: ObservableObject {
    @Published var hostVideoTrack: VideoTrack?
    @Published var connectStatus: String = "Conectando..."
    @Published var reconnecting: Bool = false
    @Published var viewerCount: Int = 0
    @Published var connectionQuality: String = "good"
    @Published var pinnedComment: LivePinnedComment?
    @Published var slowModeSeconds: Int = 0
    @Published var slowModeBlockedUntil: Date = Date(timeIntervalSince1970: 0)
    @Published var chatMessages: [LiveChatMessage] = []
    @Published var floatingReactions: [LiveFloatingReaction] = []
    @Published var activePoll: LivePoll?
    @Published var myPollVote: Int?
    @Published var cohostRequested: Bool = false
    @Published var cohostApproved: Bool = false
    @Published var ended: Bool = false
    @Published var endedReason: String = ""
}

final class LiveViewerViewController: UIViewController {

    static let viewerEndedNotification = Notification.Name("ExpoCallKitNativeCallEnded")

    // MARK: - Params

    let liveSessionId: String
    let lkUrl: String
    let lkToken: String
    let hostEmail: String
    let hostName: String
    let hostAvatar: String?
    let viewerEmail: String

    // MARK: - LiveKit Room

    private var room: Room?
    private let session = LiveViewerSessionState()

    // MARK: - Reconnect

    private var reconnectAttempts: Int = 0
    private let maxReconnect: Int = 3
    private let reconnectBackoff: [TimeInterval] = [1, 2, 4]

    // MARK: - WS

    private var ws: URLSessionWebSocketTask?
    private var wsSession: URLSession?
    private var wsAuthed: Bool = false
    private var wsReconnectAttempts: Int = 0
    private var wsPingTimer: Timer?
    private let wsURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private let appGroupId = "group.com.onemundo.mail"

    private var reactionGcTimer: Timer?

    // MARK: - PiP scaffolding (deferred)

    private var pipController: AVPictureInPictureController?
    private var pipResignObserver: NSObjectProtocol?

    // MARK: - Init

    init(liveSessionId: String,
         lkUrl: String,
         lkToken: String,
         hostEmail: String,
         hostName: String,
         hostAvatar: String?,
         viewerEmail: String,
         pinnedComment: LivePinnedComment?,
         slowModeSeconds: Int) {
        self.liveSessionId = liveSessionId
        self.lkUrl = lkUrl
        self.lkToken = lkToken
        self.hostEmail = hostEmail
        self.hostName = hostName
        self.hostAvatar = hostAvatar
        self.viewerEmail = viewerEmail
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
        // Seed the initial props before the SwiftUI tree mounts.
        if let p = pinnedComment {
            self.session.pinnedComment = p
        }
        self.session.slowModeSeconds = slowModeSeconds
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0, alpha: 1.0)

        let rootView = LiveViewerView(
            session: session,
            liveSessionId: liveSessionId,
            hostName: hostName,
            hostEmail: hostEmail,
            hostAvatar: hostAvatar,
            onClose: { [weak self] in self?.handleClose(reason: "user_close") },
            onSendComment: { [weak self] txt in self?.sendComment(txt) },
            onSendReaction: { [weak self] emoji in self?.sendReaction(emoji, x: nil) },
            onTap: { [weak self] in self?.handleTap() },
            onLongPressTop: { [weak self] in self?.reportLive() },
            onRequestCohost: { [weak self] in self?.requestCohost() },
            onTapPoll: { [weak self] in self?.openPollDetails() },
            onVotePollOption: { [weak self] idx in self?.votePoll(optionIndex: idx) }
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

        let burstView = LiveViewerReactionBurst(session: session)
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

        startReactionGc()
        connectLiveKit()
        connectWs()
        installPiPScaffolding()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - LiveKit

    private func connectLiveKit() {
        guard !lkUrl.isEmpty, !lkToken.isEmpty else {
            session.connectStatus = "Erro: credenciais ausentes"
            return
        }
        print("[LiveViewerVC] connecting LK — session=\(liveSessionId)")
        session.connectStatus = "Conectando..."
        session.reconnecting = reconnectAttempts > 0
        let r = Room(delegate: self)
        self.room = r
        Task { [weak self] in
            guard let self = self else { return }
            do {
                try await r.connect(url: self.lkUrl, token: self.lkToken)
                await MainActor.run {
                    self.session.connectStatus = "Conectado"
                    self.session.reconnecting = false
                }
                self.reconnectAttempts = 0
            } catch {
                print("[LiveViewerVC] connect failed: \(error)")
                await MainActor.run {
                    self.session.connectStatus = "Falha ao conectar"
                }
                self.scheduleLkReconnect()
            }
        }
    }

    private func scheduleLkReconnect() {
        guard reconnectAttempts < maxReconnect else {
            print("[LiveViewerVC] LK reconnect: max attempts reached — closing")
            handleClose(reason: "lk_unreachable")
            return
        }
        let backoff = reconnectBackoff[min(reconnectAttempts, reconnectBackoff.count - 1)]
        reconnectAttempts += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            self?.connectLiveKit()
        }
    }

    // MARK: - WS

    private func connectWs() {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let token = ud.string(forKey: "auth_token"), !token.isEmpty else {
            print("[LiveViewerVC] WS: no auth_token — skipping")
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
                print("[LiveViewerVC] WS auth send failed: \(err.localizedDescription)")
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
                print("[LiveViewerVC] WS recv failure: \(err.localizedDescription)")
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
            sendWs([
                "type": "live_subscribe",
                "live_session_id": liveSessionId,
                "viewer_email": viewerEmail,
            ])
        case "live_comment":
            handleLiveComment(obj)
        case "live_reaction":
            handleLiveReaction(obj)
        case "live_pin_comment":
            handlePinComment(obj)
        case "live_slow_mode":
            handleSlowMode(obj)
        case "live_viewer_kicked":
            handleViewerKicked(obj)
        case "live_poll_created":
            handlePollCreated(obj)
        case "live_poll_voted":
            handlePollVoted(obj)
        case "live_poll_closed":
            handlePollClosed(obj)
        case "live_cohost_approved":
            handleCohostApproved(obj)
        case "live_viewer_count":
            if let n = obj["count"] as? Int {
                Task { @MainActor [weak self] in self?.session.viewerCount = n }
            }
        case "live_ended":
            handleClose(reason: "host_ended")
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
                print("[LiveViewerVC] WS send failed: \(err.localizedDescription)")
            }
        }
    }

    private func startWsPing() {
        wsPingTimer?.invalidate()
        wsPingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            self?.ws?.sendPing { err in
                if let err = err {
                    print("[LiveViewerVC] WS ping failed: \(err.localizedDescription)")
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
            print("[LiveViewerVC] WS reconnect: max attempts reached")
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

    // MARK: - WS event handlers

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

    private func handleViewerKicked(_ obj: [String: Any]) {
        // Only react if this viewer is the kicked one (server may broadcast
        // to all subscribers for parity, but only this client should hang
        // up).
        let kickedEmail = (obj["viewer_email"] as? String) ?? ""
        if kickedEmail.lowercased() == viewerEmail.lowercased() {
            print("[LiveViewerVC] kicked by host — auto-hangup")
            handleClose(reason: "kicked")
        }
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
            self?.session.myPollVote = nil
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

    private func handleCohostApproved(_ obj: [String: Any]) {
        let email = (obj["viewer_email"] as? String) ?? ""
        if email.lowercased() == viewerEmail.lowercased() {
            print("[LiveViewerVC] cohost approved — TODO upgrade to publisher")
            // Stage 2/3 of #929 — the JS-side already handles the
            // publisher-upgrade path; the iOS native viewer screen would
            // need a separate cohost LK token + publish flow. For now we
            // just flip the cohostApproved flag so the chip changes.
            Task { @MainActor [weak self] in
                self?.session.cohostApproved = true
            }
        }
    }

    // MARK: - User actions

    private func sendComment(_ text: String) {
        // Honor slow mode locally to avoid the round-trip + server reject.
        if session.slowModeSeconds > 0, session.slowModeBlockedUntil > Date() {
            return
        }
        sendWs([
            "type": "live_comment",
            "live_session_id": liveSessionId,
            "text": text,
            "author_email": viewerEmail,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ])
        if session.slowModeSeconds > 0 {
            session.slowModeBlockedUntil = Date().addingTimeInterval(TimeInterval(session.slowModeSeconds))
        }
    }

    private func sendReaction(_ emoji: String, x: Double?) {
        let xCoord = x ?? Double.random(in: 0.4...0.9)
        sendWs([
            "type": "live_reaction",
            "live_session_id": liveSessionId,
            "emoji": emoji,
            "x": xCoord,
            "reactor_email": viewerEmail,
        ])
        handleLiveReaction(["emoji": emoji, "x": xCoord])
    }

    private func handleTap() {
        // Tap on the video area = spawn a heart at a random x (same UX as
        // Instagram Live double-tap). iOS 15.1 SwiftUI's onTapGesture
        // doesn't expose the tap point without dropping to UIKit gesture
        // recognizers, so we randomize x server-side — the heart still
        // bursts and viewers can tap-spam to taste.
        sendReaction("❤️", x: nil)
    }

    private func reportLive() {
        let alert = UIAlertController(
            title: "Reportar live",
            message: "Esta live viola alguma regra?",
            preferredStyle: .actionSheet
        )
        for reason in ["Spam", "Conteúdo inapropriado", "Assédio", "Violência", "Outro"] {
            alert.addAction(UIAlertAction(title: reason, style: .destructive) { [weak self] _ in
                guard let self = self else { return }
                self.sendWs([
                    "type": "live_report",
                    "live_session_id": self.liveSessionId,
                    "reporter_email": self.viewerEmail,
                    "reason": reason,
                ])
                let ack = UIAlertController(title: "Obrigado", message: "Recebemos seu relato.", preferredStyle: .alert)
                ack.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(ack, animated: true)
            })
        }
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel))
        present(alert, animated: true)
    }

    private func requestCohost() {
        guard !session.cohostRequested else { return }
        sendWs([
            "type": "live_cohost_request",
            "live_session_id": liveSessionId,
            "viewer_email": viewerEmail,
        ])
        Task { @MainActor [weak self] in self?.session.cohostRequested = true }
    }

    private func openPollDetails() {
        guard let poll = session.activePoll else { return }
        let total = max(poll.totalVotes, 1)
        var body = ""
        for opt in poll.options {
            let pct = Double(opt.votes) * 100.0 / Double(total)
            body += "\(opt.text) — \(opt.votes) (\(Int(pct))%)\n"
        }
        let alert = UIAlertController(title: poll.question, message: body, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "Fechar", style: .cancel))
        present(alert, animated: true)
    }

    private func votePoll(optionIndex: Int) {
        guard let poll = session.activePoll, !poll.closed else { return }
        guard session.myPollVote == nil else { return }
        sendWs([
            "type": "live_poll_vote",
            "live_session_id": liveSessionId,
            "poll_id": poll.id,
            "option_index": optionIndex,
            "voter_email": viewerEmail,
        ])
        Task { @MainActor [weak self] in
            guard let self = self, var p = self.session.activePoll else { return }
            self.session.myPollVote = optionIndex
            if optionIndex < p.options.count {
                p.options[optionIndex].votes += 1
                p.totalVotes += 1
                self.session.activePoll = p
            }
        }
    }

    private func handleClose(reason: String) {
        guard !session.ended else { return }
        session.ended = true
        session.endedReason = reason
        NotificationCenter.default.post(
            name: LiveViewerViewController.viewerEndedNotification,
            object: nil,
            userInfo: ["callId": liveSessionId, "reason": reason]
        )
        // Tell server we're leaving (host updates viewer count).
        sendWs([
            "type": "live_unsubscribe",
            "live_session_id": liveSessionId,
            "viewer_email": viewerEmail,
        ])
        if let r = self.room {
            self.room = nil
            Task { await r.disconnect() }
        }
        ws?.cancel(with: .normalClosure, reason: nil)
        ws = nil
        wsPingTimer?.invalidate()
        wsPingTimer = nil
        reactionGcTimer?.invalidate()
        reactionGcTimer = nil

        // If kicked, show a brief alert before dismissing so the viewer
        // understands what happened — otherwise the screen just closes
        // and feels like a crash.
        if reason == "kicked" {
            let alert = UIAlertController(
                title: "Você foi removido",
                message: "O host removeu você desta live.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                self?.dismiss(animated: true, completion: nil)
            })
            present(alert, animated: true)
        } else {
            dismiss(animated: true, completion: nil)
        }
    }

    // MARK: - Reaction GC

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

    // MARK: - PiP (deferred — same blocker as CallViewController)

    /// Currently a no-op. LiveKit Swift 2.x does not publicly expose a
    /// CMSampleBuffer feed for VideoTrack, so the
    /// AVPictureInPictureController content source cannot be built. We
    /// keep the wiring in one place so a future round can land PiP once
    /// the renderer API is verified on-device (see the CallViewController
    /// comment for full reasoning).
    ///
    /// When PiP DOES become possible, the viewer use case is ideal:
    /// scroll-to-shrink during the chat scroll, persistent floating tile
    /// while the user explores other tabs. The Stage #1000 spec calls
    /// this out as a nice-to-have, not a blocker.
    private func installPiPScaffolding() {
        guard #available(iOS 15.0, *) else { return }
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
        // [TODO iOS PiP, viewer]
        //   1. Build a CMSampleBuffer adapter from
        //      VideoTrack.add(videoRenderer:) once LK SDK exposes the
        //      Swift-public renderer API.
        //   2. Wrap in AVPictureInPictureVideoCallViewController.
        //   3. Call pipController.startPictureInPicture() on
        //      willResignActive (and on a "scroll-to-shrink" gesture).
        let center = NotificationCenter.default
        pipResignObserver = center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let _ = self else { return }
            if #available(iOS 15.0, *), let pip = self?.pipController, pip.isPictureInPicturePossible {
                pip.startPictureInPicture()
            }
        }
    }

    deinit {
        reactionGcTimer?.invalidate()
        wsPingTimer?.invalidate()
        ws?.cancel(with: .goingAway, reason: nil)
        if let r = self.room {
            Task { await r.disconnect() }
        }
        if let obs = pipResignObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // MARK: - Presentation

    static func present(from base: UIViewController,
                        liveSessionId: String,
                        lkUrl: String,
                        lkToken: String,
                        hostEmail: String,
                        hostName: String,
                        hostAvatar: String?,
                        viewerEmail: String,
                        pinnedComment: LivePinnedComment?,
                        slowModeSeconds: Int) {
        let top = topMostViewController(from: base)
        let vc = LiveViewerViewController(
            liveSessionId: liveSessionId,
            lkUrl: lkUrl,
            lkToken: lkToken,
            hostEmail: hostEmail,
            hostName: hostName,
            hostAvatar: hostAvatar,
            viewerEmail: viewerEmail,
            pinnedComment: pinnedComment,
            slowModeSeconds: slowModeSeconds
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

extension LiveViewerViewController: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        print("[LiveViewerVC] roomDidConnect")
        Task { @MainActor [weak self] in
            self?.session.connectStatus = "Conectado"
            self?.session.reconnecting = false
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[LiveViewerVC] didDisconnectWithError: \(String(describing: error))")
        Task { @MainActor [weak self] in
            self?.session.connectStatus = "Reconectando..."
            self?.session.reconnecting = true
        }
        scheduleLkReconnect()
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        guard let track = publication.track as? VideoTrack else { return }
        let participantEmail = (participant.identity?.stringValue ?? "").lowercased()
        // The viewer only renders the host's video, not other viewers /
        // cohosts (those would need a separate grid). Identify the host
        // by matching the LK identity (server-side: identity is the email).
        if participantEmail == hostEmail.lowercased() || participantEmail.isEmpty {
            Task { @MainActor [weak self] in
                self?.session.hostVideoTrack = track
            }
        } else {
            // Cohost — Stage 2 will render this in a side tile. For now we
            // just log so the viewer doesn't see two competing fullscreens.
            print("[LiveViewerVC] cohost video subscribe (identity=\(participantEmail)) — ignored")
        }
    }

    func room(_ room: Room,
              participant: RemoteParticipant,
              didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .video else { return }
        let participantEmail = (participant.identity?.stringValue ?? "").lowercased()
        if participantEmail == hostEmail.lowercased() {
            Task { @MainActor [weak self] in
                self?.session.hostVideoTrack = nil
            }
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        // The host may join after us if we beat them to the room. We don't
        // care about cohost joins on the viewer side (Stage 2).
        print("[LiveViewerVC] participant joined — identity=\(participant.identity?.stringValue ?? "?")")
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = (participant.identity?.stringValue ?? "").lowercased()
        if identity == hostEmail.lowercased() {
            // Host left — clear the video; the WS live_ended event (if
            // sent) will trigger the actual close.
            Task { @MainActor [weak self] in
                self?.session.hostVideoTrack = nil
                self?.session.connectStatus = "Host saiu"
            }
        }
    }

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

    func room(_ room: Room,
              participant: Participant,
              didUpdateConnectionQuality quality: ConnectionQuality) {
        // Local connection quality drives the auto-hide bars.
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
