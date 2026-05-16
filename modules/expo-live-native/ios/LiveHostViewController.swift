import UIKit
import SwiftUI
import LiveKitClient
import AVFoundation
import Foundation

// LiveHostViewController — Stage 2 (2026-05-16).
//
// UIKit shell hosting a SwiftUI LiveHostView. Mirrors the architecture of
// modules/expo-callkit/CallViewController.swift:
//   - SwiftUI binds to an ObservableObject `LiveHostSessionState`.
//   - The VC owns the LiveKit `Room` (publisher: mic + camera).
//   - A separate `URLSessionWebSocketTask` carries chat / reactions / viewer-
//     count events on channel `live_<sessionId>` over wss://ws.chatyy.com.br/ws.
//
// Stage 2 single-publisher only — cohost flow defers.

// ────────────────────────────────────────────────────────────────────────────
// Session state (ObservableObject) — SwiftUI source of truth.
// ────────────────────────────────────────────────────────────────────────────

final class LiveHostSessionState: ObservableObject {
    @Published var status: String
    @Published var viewerCount: Int
    @Published var durationSecs: Int
    @Published var comments: [LiveComment]
    @Published var reactions: [LiveReactionParticle]
    @Published var localVideoTrack: LocalVideoTrack?
    @Published var composerVisible: Bool
    @Published var paused: Bool

    init() {
        self.status = "Conectando…"
        self.viewerCount = 0
        self.durationSecs = 0
        self.comments = []
        self.reactions = []
        self.localVideoTrack = nil
        self.composerVisible = false
        self.paused = false
    }
}

struct LiveComment: Identifiable, Equatable {
    let id: UUID = UUID()
    let name: String
    let text: String
}

struct LiveReactionParticle: Identifiable, Equatable {
    let id: UUID = UUID()
    let emoji: String
    let xOffset: CGFloat
}

// ────────────────────────────────────────────────────────────────────────────
// View controller
// ────────────────────────────────────────────────────────────────────────────

final class LiveHostViewController: UIViewController {

    let lkToken: String
    let lkUrl: String
    let roomName: String
    let hostEmail: String
    let title_: String?
    let audience: String?

    private let session = LiveHostSessionState()
    private var room: Room?
    private let startedAt = Date()
    private var durationTimer: Timer?

    // WebSocket
    private var wsTask: URLSessionWebSocketTask?
    private var wsAuthed: Bool = false
    private var wsURLSession: URLSession?
    private var wsOutbox: [String] = []
    private let wsURL = URL(string: "wss://ws.chatyy.com.br/ws")!

    init(lkToken: String,
         lkUrl: String,
         roomName: String,
         hostEmail: String,
         title: String?,
         audience: String?) {
        self.lkToken = lkToken
        self.lkUrl = lkUrl
        self.roomName = roomName
        self.hostEmail = hostEmail
        self.title_ = title
        self.audience = audience
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        self.isModalInPresentation = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Mount SwiftUI tree
        let rootView = LiveHostView(
            session: session,
            hostEmail: hostEmail,
            roomName: roomName,
            onClose: { [weak self] in self?.handleClose(reason: "user_close") },
            onSendComment: { [weak self] text in self?.sendComment(text) },
            onPauseToggle: { [weak self] in self?.togglePause() },
            onSwitchCamera: { [weak self] in self?.switchCamera() },
            onToggleComposer: { [weak self] in
                guard let self = self else { return }
                self.session.composerVisible.toggle()
            },
            onShare: { [weak self] in self?.shareLive() }
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

        // Duration timer
        durationTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.session.durationSecs = Int(Date().timeIntervalSince(self.startedAt))
            }
        }

        // LiveKit
        if !lkUrl.isEmpty && !lkToken.isEmpty {
            let r = Room(delegate: self)
            self.room = r
            Task { [weak self] in
                guard let self = self else { return }
                do {
                    try await r.connect(url: self.lkUrl, token: self.lkToken)
                    try await r.localParticipant.setMicrophone(enabled: true)
                    if let pub = try? await r.localParticipant.setCamera(enabled: true),
                       let track = pub.track as? LocalVideoTrack {
                        await MainActor.run { self.session.localVideoTrack = track }
                    }
                    await MainActor.run {
                        self.session.status = "AO VIVO"
                    }
                    self.sendWS([
                        "type": "live_start",
                        "session_id": self.roomName,
                    ])
                } catch {
                    print("[LiveHostVC] LK connect failed: \(error)")
                    await MainActor.run { self.session.status = "Erro de conexão" }
                    self.emitError(error.localizedDescription)
                }
            }
        } else {
            session.status = "Sem token"
        }

        // WebSocket
        startWS()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // ────────────────────────────────────────────────────────────────────
    //  Actions
    // ────────────────────────────────────────────────────────────────────

    private func sendComment(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sendWS([
            "type": "live_chat",
            "session_id": roomName,
            "content": trimmed,
        ])
        appendComment(name: "Você", text: trimmed)
    }

    private func togglePause() {
        session.paused.toggle()
        let paused = session.paused
        Task { [weak self] in
            guard let r = self?.room else { return }
            do {
                _ = try await r.localParticipant.setCamera(enabled: !paused)
                try await r.localParticipant.setMicrophone(enabled: !paused)
            } catch {
                print("[LiveHostVC] togglePause failed: \(error)")
            }
        }
    }

    private func switchCamera() {
        Task { [weak self] in
            guard let r = self?.room else { return }
            do {
                // LK Swift 2.x: cycle camera by disabling + re-enabling, mirrors
                // the Android setCameraEnabled(false→true) toggle. The SDK's
                // public CameraCapturer.switchPosition() exists but its
                // visibility across pinned 2.x patch versions is not
                // guaranteed — toggle is the conservative path.
                _ = try await r.localParticipant.setCamera(enabled: false)
                _ = try await r.localParticipant.setCamera(enabled: true)
            } catch {
                print("[LiveHostVC] switchCamera failed: \(error)")
            }
        }
    }

    private func shareLive() {
        let text = "Tô ao vivo no Chatyy! https://chatyy.com.br/live/\(roomName)"
        let av = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        present(av, animated: true, completion: nil)
    }

    private func appendComment(name: String, text: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.session.comments.append(LiveComment(name: name, text: text))
            if self.session.comments.count > 50 {
                self.session.comments.removeFirst(self.session.comments.count - 50)
            }
        }
    }

    private func spawnReaction(_ emoji: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let particle = LiveReactionParticle(
                emoji: emoji,
                xOffset: CGFloat.random(in: -20...20)
            )
            self.session.reactions.append(particle)
            if self.session.reactions.count > 20 {
                self.session.reactions.removeFirst(self.session.reactions.count - 20)
            }
            // Auto-cleanup after animation duration.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in
                guard let self = self else { return }
                if let idx = self.session.reactions.firstIndex(where: { $0.id == particle.id }) {
                    self.session.reactions.remove(at: idx)
                }
            }
        }
    }

    private func handleClose(reason: String) {
        sendWS([
            "type": "live_end",
            "session_id": roomName,
        ])
        durationTimer?.invalidate()
        durationTimer = nil

        // Release Room before VC disappears so LK tears down promptly.
        if let r = self.room {
            self.room = nil
            Task { await r.disconnect() }
        }
        // WS close
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil

        NotificationCenter.default.post(
            name: LiveNativeNotifications.didEnd,
            object: nil,
            userInfo: ["roomName": roomName, "reason": reason]
        )
        dismiss(animated: true, completion: nil)
    }

    private func emitError(_ message: String) {
        NotificationCenter.default.post(
            name: LiveNativeNotifications.didError,
            object: nil,
            userInfo: ["roomName": roomName, "message": message]
        )
    }

    // ────────────────────────────────────────────────────────────────────
    //  WebSocket
    // ────────────────────────────────────────────────────────────────────

    private func bearerToken() -> String? {
        // Reuse the bearer that the JS persistAuthForNativeCall path stashed
        // in UserDefaults via the callkit module. Standard suite — works for
        // app-domain UserDefaults on iOS.
        let d = UserDefaults.standard
        if let t = d.string(forKey: "auth_token"), !t.isEmpty { return t }
        if let t = d.string(forKey: "ExpoCallKit_auth_token"), !t.isEmpty { return t }
        return nil
    }

    private func startWS() {
        guard let token = bearerToken() else {
            print("[LiveHostVC] no bearer in UserDefaults — WS chat disabled")
            return
        }
        let cfg = URLSessionConfiguration.default
        let session = URLSession(configuration: cfg)
        wsURLSession = session
        let task = session.webSocketTask(with: wsURL)
        wsTask = task
        task.resume()

        // Send auth
        let authJson: [String: Any] = ["type": "auth", "token": token]
        if let data = try? JSONSerialization.data(withJSONObject: authJson),
           let s = String(data: data, encoding: .utf8) {
            task.send(.string(s)) { [weak self] err in
                if let err = err {
                    print("[LiveHostVC] WS auth send failed: \(err)")
                    self?.scheduleWsReconnect()
                }
            }
        }
        scheduleWsRecv()
    }

    private func scheduleWsRecv() {
        wsTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                print("[LiveHostVC] WS recv failed: \(err)")
                self.wsAuthed = false
                self.scheduleWsReconnect()
            case .success(let msg):
                switch msg {
                case .string(let s): self.handleWsFrame(s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) { self.handleWsFrame(s) }
                @unknown default: break
                }
                self.scheduleWsRecv()
            }
        }
    }

    private func scheduleWsReconnect() {
        guard isViewLoaded else { return }
        wsAuthed = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, self.view.window != nil else { return }
            self.startWS()
        }
    }

    private func handleWsFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        let type = (obj["type"] as? String) ?? ""
        switch type {
        case "auth_success":
            wsAuthed = true
            // Drain queued outbox
            let pending = wsOutbox
            wsOutbox.removeAll()
            for s in pending { rawSendWS(s) }
        case "live_chat":
            let name = (obj["sender_name"] as? String) ?? (obj["sender_email"] as? String) ?? "?"
            let content = (obj["content"] as? String) ?? ""
            if !content.isEmpty { appendComment(name: name, text: content) }
        case "live_reaction":
            let emoji = (obj["emoji"] as? String) ?? "♥"
            spawnReaction(emoji)
        case "live_viewer_count":
            let count = (obj["count"] as? Int) ?? 0
            DispatchQueue.main.async { [weak self] in
                self?.session.viewerCount = count
            }
        case "live_viewer_joined":
            let name = (obj["viewer_name"] as? String) ?? (obj["viewer_email"] as? String) ?? "?"
            appendComment(name: "Sistema", text: "\(name) entrou")
        case "live_join_request":
            let viewer = (obj["viewer_name"] as? String) ?? (obj["viewer_email"] as? String) ?? "?"
            appendComment(name: "Sistema", text: "\(viewer) quer entrar como cohost")
        default:
            break
        }
    }

    private func sendWS(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return }
        if wsAuthed {
            rawSendWS(s)
        } else {
            wsOutbox.append(s)
            if wsOutbox.count > 64 { wsOutbox.removeFirst(wsOutbox.count - 64) }
        }
    }

    private func rawSendWS(_ json: String) {
        wsTask?.send(.string(json)) { err in
            if let err = err { print("[LiveHostVC] WS send err: \(err)") }
        }
    }

    deinit {
        durationTimer?.invalidate()
        wsTask?.cancel(with: .goingAway, reason: nil)
        if let r = self.room {
            Task { await r.disconnect() }
        }
    }
}

// MARK: - RoomDelegate

extension LiveHostViewController: RoomDelegate {
    func roomDidConnect(_ room: Room) {
        print("[LiveHostVC] roomDidConnect")
        DispatchQueue.main.async { [weak self] in
            self?.session.status = "AO VIVO"
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        print("[LiveHostVC] didDisconnectWithError \(String(describing: error))")
        DispatchQueue.main.async { [weak self] in
            self?.handleClose(reason: "room_disconnect")
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? ""
        let name = participant.name ?? ""
        print("[LiveHostVC] participantDidConnect \(identity)")
        NotificationCenter.default.post(
            name: LiveNativeNotifications.viewerJoined,
            object: nil,
            userInfo: [
                "roomName": roomName,
                "identity": identity,
                "name": name,
            ]
        )
    }
}

// ────────────────────────────────────────────────────────────────────────────
// SwiftUI tree — co-located in the same file so we don't introduce new Swift
// source files into the pod source set (the podspec globs `**/*.swift`, but
// keeping files-changed small reduces Xcode project churn on every prebuild).
// ────────────────────────────────────────────────────────────────────────────

struct LiveHostView: View {
    @ObservedObject var session: LiveHostSessionState
    let hostEmail: String
    let roomName: String
    let onClose: () -> Void
    let onSendComment: (String) -> Void
    let onPauseToggle: () -> Void
    let onSwitchCamera: () -> Void
    let onToggleComposer: () -> Void
    let onShare: () -> Void

    @State private var composerText: String = ""

    private let chip = Color.black.opacity(0.5)
    private let red = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)

    var body: some View {
        ZStack {
            // Camera preview (own camera) — mirrored.
            if let local = session.localVideoTrack {
                SwiftUIVideoView(local, layoutMode: .fill, mirrorMode: .mirror)
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            // Reactions burst layer.
            ForEach(session.reactions) { r in
                ReactionParticleView(emoji: r.emoji, xOffset: r.xOffset)
            }

            VStack(spacing: 0) {
                topBar
                Spacer()
                commentsOverlay
                    .frame(maxHeight: 260)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                bottomBar
            }

            if session.composerVisible {
                composerOverlay
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Connecting overlay.
            if session.status != "AO VIVO" {
                Text(session.status)
                    .foregroundColor(.white)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(chip).clipShape(Capsule())
            }
        }
        .animation(.easeInOut(duration: 0.2), value: session.composerVisible)
    }

    // ── Top bar
    private var topBar: some View {
        HStack(spacing: 8) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(chip).clipShape(Circle())
            }
            HStack(spacing: 4) {
                Circle().fill(Color.white).frame(width: 6, height: 6)
                Text("AO VIVO").font(.system(size: 12, weight: .bold)).foregroundColor(.white)
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(red).clipShape(Capsule())
            .opacity(session.status == "AO VIVO" ? 1 : 0.55)

            Text(formatViewerCount(session.viewerCount))
                .font(.system(size: 12)).foregroundColor(.white)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(chip).clipShape(Capsule())

            Text(durationString(session.durationSecs))
                .font(.system(size: 12)).foregroundColor(.white)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(chip).clipShape(Capsule())

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
    }

    // ── Comment list
    private var commentsOverlay: some View {
        HStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(session.comments) { c in
                            HStack(alignment: .top, spacing: 4) {
                                Text(c.name).fontWeight(.bold).foregroundColor(.white).font(.system(size: 13))
                                Text(c.text).foregroundColor(.white).font(.system(size: 13))
                            }
                            .id(c.id)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                        }
                    }
                }
                .onChange(of: session.comments.count) { _ in
                    if let last = session.comments.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            .frame(maxWidth: 320)
            .background(Color.black.opacity(0.35))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            Spacer()
        }
    }

    // ── Bottom action bar
    private var bottomBar: some View {
        HStack(spacing: 8) {
            Button(action: onToggleComposer) {
                Text("Comentários · \(session.comments.count)")
                    .font(.system(size: 13)).foregroundColor(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(chip).clipShape(Capsule())
            }
            Button(action: onShare) {
                Text("Compartilhar")
                    .font(.system(size: 13)).foregroundColor(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(chip).clipShape(Capsule())
            }
            Button(action: onPauseToggle) {
                Text(session.paused ? "Retomar" : "Pausar")
                    .font(.system(size: 13)).foregroundColor(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(chip).clipShape(Capsule())
            }
            Button(action: onSwitchCamera) {
                Image(systemName: "camera.rotate")
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(chip).clipShape(Circle())
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 28)
    }

    // ── Modal composer
    private var composerOverlay: some View {
        VStack {
            Spacer()
            HStack {
                TextField("Diga algo…", text: $composerText)
                    .textFieldStyle(.plain)
                    .foregroundColor(.white)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0))
                    .clipShape(Capsule())
                Button(action: {
                    let t = composerText
                    composerText = ""
                    onSendComment(t)
                }) {
                    Text("Enviar")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(red).clipShape(Capsule())
                }
            }
            .padding(12)
            .background(Color.black.opacity(0.8))
        }
    }

    private func formatViewerCount(_ n: Int) -> String {
        let label: String
        if n >= 1_000_000 { label = String(format: "%.1fM", Double(n) / 1_000_000) }
        else if n >= 1_000 { label = String(format: "%.1fK", Double(n) / 1_000) }
        else { label = "\(n)" }
        return "\(label) 👁"
    }

    private func durationString(_ s: Int) -> String {
        let m = s / 60, sec = s % 60
        return String(format: "%02d:%02d", m, sec)
    }
}

/// One floating heart particle — translates up + fades out over 2s.
struct ReactionParticleView: View {
    let emoji: String
    let xOffset: CGFloat
    @State private var animate = false

    var body: some View {
        GeometryReader { geo in
            Text(emoji)
                .font(.system(size: 32))
                .foregroundColor(Color(red: 1.0, green: 0.23, blue: 0.42))
                .position(
                    x: geo.size.width * 0.5 + xOffset + (animate ? 24 : 0),
                    y: animate ? geo.size.height * 0.4 : geo.size.height * 0.78
                )
                .opacity(animate ? 0 : 1)
                .onAppear {
                    withAnimation(.easeOut(duration: 2.0)) { animate = true }
                }
        }
        .allowsHitTesting(false)
    }
}
