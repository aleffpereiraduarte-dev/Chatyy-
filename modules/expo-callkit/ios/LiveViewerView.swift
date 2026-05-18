import SwiftUI
import UIKit
import LiveKitClient

// [Stage #1000 native live viewer, 2026-05-17]
//
// SwiftUI viewer-side UI for /live-viewer. Mirrors the JS
// app/live-viewer.js (~3900 lines) but renders the LK remote feed
// directly via SwiftUIVideoView. The viewer subscribes only — no
// camera/mic publish unless they're an approved cohost (a follow-up
// stage handles the publisher upgrade).
//
// Layout overview (top → bottom):
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ [host avatar+name] [AO VIVO] [viewers]  [bars] [X]      │  topBar()
//   ├─────────────────────────────────────────────────────────┤
//   │                                                         │
//   │            Full-screen remote host video                │  remoteFill()
//   │              (LK remote VideoView)                      │
//   │                                                         │
//   │       [Pinned comment chip — top-center]                │
//   │       [Active poll overlay — tap to vote]               │
//   │                                                         │
//   │       [Slow mode toast]                                 │
//   │                                                         │
//   │   ─────────────────────────────────────                 │
//   │   [chat messages overlay]                               │
//   │   [composer + 5 reaction emojis]                        │  bottomBar()
//   │   [Pedir pra entrar]  (cohost request)                  │
//   └─────────────────────────────────────────────────────────┘
//
// Long-press top area → "Reportar live" sheet.
//
// Source of truth = LiveViewerSessionState (declared in
// LiveViewerViewController.swift). All mutations happen on the main
// actor; SwiftUI re-renders.

struct LiveViewerView: View {
    @ObservedObject var session: LiveViewerSessionState

    // Initial props passed from the JS bridge call.
    let liveSessionId: String
    let hostName: String
    let hostEmail: String
    let hostAvatar: String?

    // Callbacks wired by the hosting LiveViewerViewController.
    let onClose: () -> Void
    let onSendComment: (String) -> Void
    let onSendReaction: (String) -> Void
    let onTap: () -> Void                  // tap-to-spawn-heart (random x server-side)
    let onLongPressTop: () -> Void
    let onRequestCohost: () -> Void
    let onTapPoll: () -> Void
    let onVotePollOption: (Int) -> Void

    // Palette (same as broadcast).
    private let bg          = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chip        = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let liveRed     = Color(red: 0xDC/255.0, green: 0x26/255.0, blue: 0x26/255.0)
    private let secondary   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)
    private let overlayBg   = Color.black.opacity(0.35)

    @State private var commentDraft: String = ""
    @State private var livePulse: Bool = false

    var body: some View {
        ZStack {
            remoteFill()
                .contentShape(Rectangle())
                .onTapGesture {
                    onTap()
                }
                .onLongPressGesture(minimumDuration: 0.7) {
                    onLongPressTop()
                }

            VStack(spacing: 0) {
                topBar()
                pinnedCommentChip()
                Spacer()
            }

            // Center column for the active poll overlay (auto-hides when
            // closed by the host).
            if let poll = session.activePoll {
                VStack {
                    Spacer().frame(height: 220)
                    pollOverlay(poll)
                    Spacer()
                }
            }

            VStack(spacing: 0) {
                Spacer()
                slowModeToast()
                cohostRequestBar()
                chatOverlay()
                bottomBar()
            }
        }
        .background(bg)
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                livePulse.toggle()
            }
        }
    }

    // MARK: - Remote fill

    @ViewBuilder
    private func remoteFill() -> some View {
        if let track = session.hostVideoTrack {
            SwiftUIVideoView(track)
                .ignoresSafeArea()
        } else {
            ZStack {
                bg
                VStack(spacing: 12) {
                    avatarCircle(name: hostName, email: hostEmail, size: 96)
                    Text(session.connectStatus)
                        .font(.system(size: 14))
                        .foregroundColor(secondary)
                    if session.reconnecting {
                        ProgressView()
                            .tint(.white)
                    }
                }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: - Top bar

    @ViewBuilder
    private func topBar() -> some View {
        HStack(spacing: 10) {
            avatarCircle(name: hostName, email: hostEmail, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(hostName.isEmpty ? hostEmail : hostName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    liveBadge()
                    HStack(spacing: 3) {
                        Image(systemName: "eye.fill")
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.85))
                        Text("\(session.viewerCount)")
                            .font(.system(size: 11))
                            .foregroundColor(.white.opacity(0.85))
                    }
                }
            }
            Spacer()
            connectionBars(quality: session.connectionQuality)
            Button(action: onClose) {
                ZStack {
                    Circle()
                        .fill(Color.black.opacity(0.5))
                        .frame(width: 32, height: 32)
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fechar")
        }
        .padding(.horizontal, 12)
        .padding(.top, 50)
        .padding(.bottom, 8)
        .background(
            LinearGradient(
                colors: [Color.black.opacity(0.55), Color.clear],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    @ViewBuilder
    private func liveBadge() -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(Color.white)
                .frame(width: 5, height: 5)
                .opacity(livePulse ? 1.0 : 0.4)
            Text("AO VIVO")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(liveRed)
        .clipShape(Capsule())
    }

    // Auto-hide bars when quality is excellent — same UX as Instagram /
    // YouTube Live (only surface the indicator when there's actually a
    // problem).
    // Helper extracted to avoid `@ViewBuilder` complaining about `()` results
    // from the switch's compound assignments.
    private func qualityToBars(_ quality: String) -> (Int, Color, Bool) {
        switch quality {
        case "excellent": return (3, Color.green, true)
        case "good":      return (2, Color.green, false)
        case "poor":      return (1, Color.yellow, false)
        case "lost":      return (0, Color.red, false)
        default:          return (2, Color.green, false)
        }
    }

    @ViewBuilder
    private func connectionBars(quality: String) -> some View {
        let (bars, color, hide) = qualityToBars(quality)
        if !hide {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<3, id: \.self) { i in
                    Rectangle()
                        .fill(i < bars ? color : Color.white.opacity(0.25))
                        .frame(width: 3, height: 6 + CGFloat(i * 4))
                        .cornerRadius(1)
                }
            }
            .frame(height: 14)
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Pinned comment

    @ViewBuilder
    private func pinnedCommentChip() -> some View {
        if let pinned = session.pinnedComment {
            HStack(spacing: 6) {
                Image(systemName: "pin.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.white)
                VStack(alignment: .leading, spacing: 1) {
                    Text(pinned.authorName)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.white.opacity(0.9))
                    Text(pinned.text)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(overlayBg)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.top, 6)
            .padding(.horizontal, 60)
            .transition(.opacity)
        }
    }

    // MARK: - Poll overlay (vote)

    @ViewBuilder
    private func pollOverlay(_ poll: LivePoll) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "chart.bar.fill")
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                Text(poll.question)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
                Button(action: onTapPoll) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 14))
                        .foregroundColor(.white.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
            let myVote = session.myPollVote
            ForEach(Array(poll.options.enumerated()), id: \.offset) { idx, opt in
                let pct = poll.totalVotes > 0
                    ? Double(opt.votes) * 100.0 / Double(poll.totalVotes)
                    : 0.0
                Button(action: {
                    if !poll.closed && myVote == nil {
                        onVotePollOption(idx)
                    }
                }) {
                    pollOptionRow(opt: opt, percent: pct, selected: myVote == idx, locked: poll.closed || myVote != nil)
                }
                .buttonStyle(.plain)
            }
            HStack {
                Text("\(poll.totalVotes) voto\(poll.totalVotes == 1 ? "" : "s")")
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.7))
                Spacer()
                if poll.closed {
                    Text("ENCERRADA")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(secondary)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(14)
        .background(Color.black.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 20)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private func pollOptionRow(opt: LivePollOption, percent: Double, selected: Bool, locked: Bool) -> some View {
        ZStack(alignment: .leading) {
            GeometryReader { geo in
                Rectangle()
                    .fill(selected ? liveRed.opacity(0.85) : Color.white.opacity(0.18))
                    .frame(width: geo.size.width * CGFloat(percent / 100.0), height: geo.size.height)
                    .cornerRadius(8)
            }
            HStack {
                Text(opt.text)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white)
                Spacer()
                Text(locked ? "\(Int(percent))%" : "")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white.opacity(0.85))
            }
            .padding(.horizontal, 10)
        }
        .frame(height: 36)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Slow mode toast

    @ViewBuilder
    private func slowModeToast() -> some View {
        if session.slowModeSeconds > 0 {
            HStack(spacing: 6) {
                Image(systemName: "tortoise.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.white)
                Text("Modo lento: 1 comentário a cada \(session.slowModeSeconds)s")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(overlayBg)
            .clipShape(Capsule())
            .padding(.bottom, 4)
        }
    }

    // MARK: - Cohost request bar

    @ViewBuilder
    private func cohostRequestBar() -> some View {
        if !session.cohostRequested {
            Button(action: onRequestCohost) {
                HStack {
                    Image(systemName: "person.fill.badge.plus")
                        .font(.system(size: 12))
                        .foregroundColor(.white)
                    Text("Pedir pra entrar")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.purple.opacity(0.7))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.bottom, 6)
        } else if session.cohostApproved {
            Text("Você está no ar!")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(Color.green.opacity(0.7))
                .clipShape(Capsule())
                .padding(.bottom, 6)
        } else {
            Text("Pedido enviado, aguardando...")
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.85))
                .padding(.bottom, 6)
        }
    }

    // MARK: - Chat overlay

    @ViewBuilder
    private func chatOverlay() -> some View {
        let tail = Array(session.chatMessages.suffix(6))
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tail) { msg in
                chatRow(msg)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func chatRow(_ msg: LiveChatMessage) -> some View {
        HStack(alignment: .top, spacing: 6) {
            avatarCircle(name: msg.authorName, email: msg.authorEmail, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(msg.authorName)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.white.opacity(0.9))
                    if msg.isHost {
                        Text("HOST")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(liveRed)
                            .clipShape(Capsule())
                    }
                }
                Text(msg.text)
                    .font(.system(size: 12))
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(overlayBg)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Bottom bar — composer + reaction emojis

    @ViewBuilder
    private func bottomBar() -> some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                TextField("", text: $commentDraft, prompt:
                    Text(session.slowModeSeconds > 0 ? "Modo lento ativo" : "Comente...")
                        .foregroundColor(.white.opacity(0.6))
                )
                .foregroundColor(.white)
                .font(.system(size: 14))
                .disabled(session.slowModeSeconds > 0 && session.slowModeBlockedUntil > Date())
                .submitLabel(.send)
                .onSubmit { sendComment() }

                if !commentDraft.isEmpty {
                    Button(action: sendComment) {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 16))
                            .foregroundColor(.white)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(overlayBg)
            .clipShape(Capsule())

            ForEach(LiveViewerView.reactions, id: \.self) { emoji in
                Button(action: { onSendReaction(emoji) }) {
                    Text(emoji)
                        .font(.system(size: 22))
                        .frame(width: 36, height: 36)
                        .background(Color.black.opacity(0.35))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 26)
        .padding(.top, 6)
        .background(
            LinearGradient(
                colors: [Color.clear, Color.black.opacity(0.45)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private func sendComment() {
        let trimmed = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSendComment(trimmed)
        commentDraft = ""
    }

    private static let reactions: [String] = ["❤️", "🔥", "👏", "😂", "🎉"]

    // MARK: - Helpers

    @ViewBuilder
    private func avatarCircle(name: String, email: String, size: CGFloat) -> some View {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let src = trimmed.isEmpty ? email : trimmed
        let initial = (src.first.map { String($0) } ?? "?").uppercased()
        ZStack {
            Circle()
                .fill(chip)
                .frame(width: size, height: size)
            Text(initial)
                .font(.system(size: size * 0.42, weight: .medium))
                .foregroundColor(.white)
        }
    }
}

// MARK: - Floating reactions overlay (viewer)

struct LiveViewerReactionBurst: View {
    @ObservedObject var session: LiveViewerSessionState

    var body: some View {
        ZStack {
            ForEach(session.floatingReactions) { reaction in
                FloatingHeart(reaction: reaction)
            }
        }
        .allowsHitTesting(false)
    }
}
