import SwiftUI
import UIKit
import LiveKitClient

// [Stage #999 native live broadcast, 2026-05-17]
//
// SwiftUI host UI for /live (the broadcaster side). Mirrors the JS
// app/live-broadcast.js but renders via the LiveKit Swift SDK directly so
// the host avoids the @livekit/react-native bridge tax + the WebView
// chrome that the legacy Stage 1 path used. Designed to be hosted by
// LiveBroadcastViewController via UIHostingController.
//
// Layout overview (top → bottom, edge → center):
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ [avatar+name+viewers]   [AO VIVO badge]   [bars] [X]   │  topBar()
//   ├─────────────────────────────────────────────────────────┤
//   │                                                         │
//   │            Full-screen local camera preview             │  remoteFill()
//   │              (LK localVideoTrack via                    │
//   │               SwiftUIVideoView)                         │
//   │                                                         │
//   │       [Pinned comment chip — top-center overlay]        │  pinnedComment()
//   │                                                         │
//   │                                  ┌─────────┐            │  rightRail()
//   │                                  │ flip cam│            │
//   │                                  │ flash   │            │
//   │                                  │ filters │            │
//   │                                  │ gear    │            │
//   │                                  │ END LIVE│            │
//   │                                  └─────────┘            │
//   │                                                         │
//   │   [cohost grid mini]                                    │  cohostStrip()
//   │                                                         │
//   │   ─────────────────────────────────────                 │
//   │   [chat messages overlay]                               │  chatOverlay()
//   │   [Slow mode indicator pill]                            │
//   │   [Active poll chip]                                    │
//   │   [comment input ───────────────] [emoji 5×]            │  bottomBar()
//   └─────────────────────────────────────────────────────────┘
//
// Source of truth = LiveBroadcastSessionState (declared in
// LiveBroadcastViewController.swift). All mutations happen on the main
// actor — the VC's WS handler + RoomDelegate callbacks dispatch through
// MainActor.run. SwiftUI re-renders the affected sub-views.
//
// Color palette mirrors the JS live-broadcast.js theme:
//   #0B141A bg, #1F2C34 chip, #DC2626 LIVE red, #8696A0 secondary, gold
//   #FBBF24 for gift accents.
//

struct LiveBroadcastView: View {
    @ObservedObject var session: LiveBroadcastSessionState

    // Host-side initial props (immutable). These come from the JS bridge
    // call and never change for the lifetime of the broadcast.
    let liveSessionId: String
    let hostName: String
    let hostEmail: String
    let hostAvatar: String? // URL string (currently rendered as initial)

    // Callbacks wired by the hosting LiveBroadcastViewController. Each one
    // forwards a user intent — VC owns the Room mutations + REST calls so
    // SwiftUI stays pure-ish.
    let onClose: () -> Void
    let onFlipCamera: () -> Void
    let onToggleFlash: () -> Void
    let onOpenFilters: () -> Void
    let onOpenSettings: () -> Void
    let onEndLive: () -> Void
    let onSendComment: (String) -> Void
    let onSendReaction: (String) -> Void
    let onOpenPollCreator: () -> Void
    let onTapPoll: () -> Void
    let onOpenViewerList: () -> Void

    // Palette
    private let bg          = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chip        = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let liveRed     = Color(red: 0xDC/255.0, green: 0x26/255.0, blue: 0x26/255.0)
    private let secondary   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)
    private let goldGift    = Color(red: 0xFB/255.0, green: 0xBF/255.0, blue: 0x24/255.0)
    private let overlayBg   = Color.black.opacity(0.35)

    // Comment composer local state. Lives in the SwiftUI tree because the
    // VC doesn't need to read each keystroke — only the final string when
    // the user taps Send.
    @State private var commentDraft: String = ""

    // Pulsing animation for AO VIVO badge. SwiftUI's repeatForever doesn't
    // need a phase var — but we drive opacity via a @State so previews and
    // tests can inspect it.
    @State private var livePulse: Bool = false

    var body: some View {
        ZStack {
            // 1. Camera preview — fills the screen.
            cameraFill()

            // 2. Top bar.
            VStack(spacing: 0) {
                topBar()
                pinnedCommentChip()
                Spacer()
            }

            // 3. Right rail (host controls).
            HStack {
                Spacer()
                rightRail()
                    .padding(.trailing, 12)
            }
            .padding(.top, 120)

            // 4. Cohost grid + chat overlay + bottom composer.
            VStack(spacing: 0) {
                Spacer()
                cohostStrip()
                activePollChip()
                slowModeIndicator()
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

    // MARK: - Camera fill

    @ViewBuilder
    private func cameraFill() -> some View {
        if let track = session.localVideoTrack {
            SwiftUIVideoView(track)
                .ignoresSafeArea()
        } else {
            ZStack {
                bg
                VStack(spacing: 12) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 48))
                        .foregroundColor(secondary)
                    Text(session.cameraStatus)
                        .font(.system(size: 14))
                        .foregroundColor(secondary)
                }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: - Top bar

    @ViewBuilder
    private func topBar() -> some View {
        HStack(spacing: 10) {
            // Host avatar (left).
            avatarCircle(name: hostName, email: hostEmail, size: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(hostName.isEmpty ? hostEmail : hostName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Image(systemName: "eye.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.85))
                    Text("\(session.viewerCount)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.85))
                    Text("·")
                        .foregroundColor(.white.opacity(0.6))
                    Text(formatDuration(session.durationSeconds))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.85))
                }
            }
            .onTapGesture { onOpenViewerList() }

            Spacer()

            liveBadge()

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
                colors: [Color.black.opacity(0.6), Color.clear],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    // Pulsing red "AO VIVO" pill, top-center adjacent.
    @ViewBuilder
    private func liveBadge() -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(Color.white)
                .frame(width: 6, height: 6)
                .opacity(livePulse ? 1.0 : 0.4)
            Text("AO VIVO")
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(liveRed)
        .clipShape(Capsule())
    }

    // 4-bar connection indicator. Matches the JS-side cell-tower pattern.
    // Helper extracted to avoid `@ViewBuilder` complaining about `()` results
    // from the switch's compound assignments.
    private func qualityToBars(_ quality: String) -> (Int, Color) {
        switch quality {
        case "excellent": return (3, Color.green)
        case "good":      return (2, Color.green)
        case "poor":      return (1, Color.yellow)
        case "lost":      return (0, Color.red)
        default:          return (2, Color.green)
        }
    }

    @ViewBuilder
    private func connectionBars(quality: String) -> some View {
        let (bars, color) = qualityToBars(quality)
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

    // MARK: - Right rail

    @ViewBuilder
    private func rightRail() -> some View {
        VStack(spacing: 14) {
            railButton(systemName: "arrow.triangle.2.circlepath.camera", label: "Câmera", action: onFlipCamera)
            railButton(
                systemName: session.flashOn ? "bolt.fill" : "bolt",
                label: "Flash",
                tint: session.flashOn ? goldGift : nil,
                action: onToggleFlash
            )
            railButton(systemName: "wand.and.stars", label: "Filtros", action: onOpenFilters)
            railButton(systemName: "gearshape.fill", label: "Mais", action: onOpenSettings)
            railButton(systemName: "chart.bar.xaxis", label: "Enquete", action: onOpenPollCreator)

            // END LIVE - prominent red square button at the bottom of the rail.
            Button(action: onEndLive) {
                VStack(spacing: 4) {
                    ZStack {
                        Circle()
                            .fill(liveRed)
                            .frame(width: 48, height: 48)
                        Image(systemName: "stop.fill")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(.white)
                    }
                    Text("Encerrar")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white)
                }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func railButton(
        systemName: String,
        label: String,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(Color.black.opacity(0.45))
                        .frame(width: 44, height: 44)
                    Image(systemName: systemName)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(tint ?? .white)
                }
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.85))
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Cohost grid
    //
    // Multi-cam grid (#922, raised to cap=4 in 2026-05-17 P0). Adaptive layout
    // by cohort count:
    //   0 → no chrome
    //   1 → single 110×150 mini PiP top-right of cohost strip (legacy look)
    //   2 → side-by-side split (50/50 width × 150 tall)
    //   3-4 → 2×2 grid
    // Backend cap is 4 (chat_live_cohosts cap raised from 1). We render even
    // when count > 4 so a server-side race doesn't crash the UI — just truncates.

    @ViewBuilder
    private func cohostStrip() -> some View {
        let cohorts = Array(session.cohosts.prefix(4))
        if !cohorts.isEmpty {
            GeometryReader { geo in
                let stripW = geo.size.width
                if cohorts.count == 1 {
                    HStack {
                        Spacer()
                        cohostTile(ch: cohorts[0], width: 110, height: 150)
                    }
                    .padding(.horizontal, 12)
                } else if cohorts.count == 2 {
                    HStack(spacing: 8) {
                        ForEach(cohorts) { ch in
                            cohostTile(ch: ch, width: (stripW - 32) / 2, height: 160)
                        }
                    }
                    .padding(.horizontal, 12)
                } else {
                    // 3 or 4 → 2×2 grid (3rd cell occupies one slot; 4th fills).
                    let cols = [GridItem(.flexible(), spacing: 8),
                                GridItem(.flexible(), spacing: 8)]
                    LazyVGrid(columns: cols, spacing: 8) {
                        ForEach(cohorts) { ch in
                            cohostTile(ch: ch, width: (stripW - 32) / 2, height: 130)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            .frame(height: cohorts.count <= 2 ? 168 : 276)
            .padding(.bottom, 6)
        }
    }

    // Single cohost tile — extracted so all 3 layouts share the same chrome
    // (rounded corners, name chip, fallback avatar when no video track yet).
    @ViewBuilder
    private func cohostTile(ch: LiveCohost, width: CGFloat, height: CGFloat) -> some View {
        ZStack(alignment: .bottomLeading) {
            if let track = ch.videoTrack {
                SwiftUIVideoView(track)
                    .frame(width: width, height: height)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(chip)
                    .frame(width: width, height: height)
                VStack {
                    Spacer()
                    avatarCircle(name: ch.name, email: ch.identity, size: 36)
                    Spacer()
                }
                .frame(width: width, height: height)
            }
            Text(ch.name)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.black.opacity(0.55))
                .clipShape(Capsule())
                .padding(6)
        }
    }

    // MARK: - Slow mode pill

    @ViewBuilder
    private func slowModeIndicator() -> some View {
        if session.slowModeSeconds > 0 {
            HStack(spacing: 6) {
                Image(systemName: "tortoise.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.white)
                Text("Modo lento: \(session.slowModeSeconds)s")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(overlayBg)
            .clipShape(Capsule())
            .padding(.bottom, 6)
        }
    }

    // MARK: - Active poll chip

    @ViewBuilder
    private func activePollChip() -> some View {
        if let poll = session.activePoll {
            Button(action: onTapPoll) {
                HStack(spacing: 10) {
                    Image(systemName: "chart.bar.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.white)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(poll.question)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Text("\(poll.totalVotes) voto\(poll.totalVotes == 1 ? "" : "s")")
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.85))
                    }
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
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.black.opacity(0.55))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
        }
    }

    // MARK: - Chat overlay

    @ViewBuilder
    private func chatOverlay() -> some View {
        // Show only the tail (last 6) so the overlay doesn't dominate the
        // screen. The full scroll is in the viewer list sheet.
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
                    Text("Comente...").foregroundColor(.white.opacity(0.6))
                )
                .foregroundColor(.white)
                .font(.system(size: 14))
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

            // 5 reaction emojis row.
            ForEach(LiveBroadcastView.reactions, id: \.self) { emoji in
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

    /// Round avatar with initial — mirrors components/AvatarCircle.js fallback.
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

    private func formatDuration(_ s: Int) -> String {
        let h = s / 3600
        let m = (s % 3600) / 60
        let sec = s % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, sec)
        } else {
            return String(format: "%d:%02d", m, sec)
        }
    }
}

// MARK: - Floating reactions overlay (heart burst)

/// Burst overlay for incoming reactions. Lives on top of the SwiftUI tree
/// but separate from LiveBroadcastView body so re-renders are scoped to the
/// floating particles only — the camera fill + composer don't redraw on
/// every emoji.
struct LiveReactionBurst: View {
    @ObservedObject var session: LiveBroadcastSessionState

    var body: some View {
        ZStack {
            ForEach(session.floatingReactions) { reaction in
                FloatingHeart(reaction: reaction)
            }
        }
        .allowsHitTesting(false)
    }
}

struct FloatingHeart: View {
    let reaction: LiveFloatingReaction
    @State private var yOffset: CGFloat = 0
    @State private var opacity: Double = 1.0
    @State private var rotation: Double = 0

    var body: some View {
        Text(reaction.emoji)
            .font(.system(size: 28))
            .opacity(opacity)
            .offset(x: reaction.xOffset, y: yOffset)
            .rotationEffect(.degrees(rotation))
            .onAppear {
                withAnimation(.easeOut(duration: 2.6)) {
                    yOffset = -260
                    opacity = 0
                    rotation = Double.random(in: -20...20)
                }
            }
    }
}
