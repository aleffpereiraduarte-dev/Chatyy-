// Stage #995 — full native SwiftUI UI, replaces JS /call.js on mobile + Stage #993 PiP wired
//
// GroupCallView.swift — the group / multi-participant call screen. Mirrors
// the JS hybrid `/call.js` group rendering: adaptive grid, per-tile speaker
// halo + mic-muted badge + name pill, draggable local-preview floating tile,
// host controls bar with mute / camera / speaker (long-press route picker) /
// hangup / hand-raise / reactions / add-member / more sheet, plus floating
// reactions over the grid.
//
// Architecture:
//   * Single ObservableObject `GroupCallSessionState` lives in
//     GroupCallViewController.swift and is mutated on the main actor as
//     LiveKit reports state.
//   * Each participant is a `GroupParticipant` row in `session.participants`.
//   * Layout rule matches WhatsApp / Meet:
//       0 remotes   → "waiting" placeholder
//       1 remote    → fullscreen single tile (the local preview floats)
//       2 remotes   → 1 col × 2 rows
//       3-4 remotes → 2 × 2 grid
//       5-6 remotes → 2 × 3 grid
//       7-9 remotes → 3 × 3 grid
//       10+         → 2 cols, scrollable
//   * SF Symbols only.
//   * pt-BR strings.

import SwiftUI
import UIKit
import Combine
import LiveKitClient

// MARK: - Models

/// One participant tile in the grid. The VC always rebuilds the array fresh
/// from LiveKit's `Room.remoteParticipants` snapshot so SwiftUI diffs cleanly.
/// Equatable manually because VideoTrack identity is by reference.
struct GroupParticipant: Identifiable, Equatable {
    let id: String
    let identity: String
    let name: String
    let videoTrack: VideoTrack?
    let audioMuted: Bool
    let isLocal: Bool
    let isSpeaking: Bool
    let handRaised: Bool
    let connectionQuality: Int // 0-3

    init(id: String,
         identity: String,
         name: String,
         videoTrack: VideoTrack? = nil,
         audioMuted: Bool = false,
         isLocal: Bool = false,
         isSpeaking: Bool = false,
         handRaised: Bool = false,
         connectionQuality: Int = 3) {
        self.id = id
        self.identity = identity
        self.name = name
        self.videoTrack = videoTrack
        self.audioMuted = audioMuted
        self.isLocal = isLocal
        self.isSpeaking = isSpeaking
        self.handRaised = handRaised
        self.connectionQuality = connectionQuality
    }

    static func == (lhs: GroupParticipant, rhs: GroupParticipant) -> Bool {
        guard lhs.identity == rhs.identity else { return false }
        guard lhs.audioMuted == rhs.audioMuted else { return false }
        guard lhs.isLocal == rhs.isLocal else { return false }
        guard lhs.name == rhs.name else { return false }
        guard lhs.isSpeaking == rhs.isSpeaking else { return false }
        guard lhs.handRaised == rhs.handRaised else { return false }
        guard lhs.connectionQuality == rhs.connectionQuality else { return false }
        switch (lhs.videoTrack, rhs.videoTrack) {
        case (nil, nil): return true
        case (let a?, let b?): return ObjectIdentifier(a) == ObjectIdentifier(b)
        default: return false
        }
    }
}

/// Source of truth for SwiftUI group call view. Mutated on main only.
final class GroupCallSessionState: ObservableObject {
    @Published var participants: [GroupParticipant]
    @Published var status: String
    @Published var micEnabled: Bool
    @Published var camEnabled: Bool
    @Published var speakerOn: Bool
    @Published var handRaised: Bool
    @Published var recording: Bool
    @Published var onHold: Bool
    @Published var connectionQuality: Int
    @Published var floatingReactions: [CallFloatingReaction]

    init(participants: [GroupParticipant] = [],
         status: String = "Conectando\u{2026}",
         micEnabled: Bool = true,
         camEnabled: Bool = true,
         speakerOn: Bool = true) {
        self.participants = participants
        self.status = status
        self.micEnabled = micEnabled
        self.camEnabled = camEnabled
        self.speakerOn = speakerOn
        self.handRaised = false
        self.recording = false
        self.onHold = false
        self.connectionQuality = 3
        self.floatingReactions = []
    }
}

// MARK: - View

struct GroupCallView: View {
    @ObservedObject var session: GroupCallSessionState
    let roomName: String
    let hasVideo: Bool

    let onHangup: () -> Void
    let onToggleMute: (Bool) -> Void
    let onToggleCam: (Bool) -> Void
    let onToggleSpeaker: (Bool) -> Void
    let onSwitchCamera: () -> Void
    let onScreenShare: () -> Void
    let onAddMember: () -> Void
    let onMinimize: () -> Void
    let onSendReaction: (String) -> Void
    let onHandRaiseToggle: (Bool) -> Void

    // Local UI state
    @State private var showAudioPicker = false
    @State private var showEmojiBar = false
    @State private var showMoreSheet = false
    @State private var pipOffset: CGSize = .zero
    @State private var pipDragOffset: CGSize = .zero
    @State private var elapsedSeconds = 0
    @State private var timer: Timer?

    // Palette (same as the 1:1 CallView so the two feel like one product)
    private let backgroundColor = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chipColor       = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let hangupColor     = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)
    private let secondaryText   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)
    private let speakerRingColor = Color(red: 0x2E/255.0, green: 0xCC/255.0, blue: 0x71/255.0)

    private var remoteParticipants: [GroupParticipant] {
        session.participants.filter { !$0.isLocal }
    }

    private var localParticipant: GroupParticipant? {
        session.participants.first(where: { $0.isLocal })
    }

    // MARK: - Body

    var body: some View {
        ZStack {
            backgroundColor.ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                Spacer().frame(height: 8)

                // Grid expands to fill available height; padded so tiles don't
                // hug the screen edges or smash into the bottom bar.
                GeometryReader { proxy in
                    gridContent(size: proxy.size)
                }
                .padding(.horizontal, 12)

                Text(statusLine)
                    .font(.system(size: 14))
                    .foregroundColor(secondaryText)
                    .padding(.top, 8)

                Spacer().frame(height: 16)

                bottomActionBar
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
            }

            // Local PiP — floats over the grid, draggable. Hidden when no
            // video or local camera is off / not published yet.
            if hasVideo, let local = localParticipant, let track = local.videoTrack {
                localPreviewTile(track)
            }

            // Floating reactions
            ZStack {
                ForEach(session.floatingReactions) { reaction in
                    FloatingEmojiView(reaction: reaction)
                }
            }
            .allowsHitTesting(false)

            if showEmojiBar {
                VStack {
                    Spacer()
                    emojiQuickBar.padding(.bottom, 132)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if showMoreSheet {
                moreSheetOverlay.transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showAudioPicker) {
            audioPickerSheet
                .presentationDetents([.height(280)])
        }
        .onAppear {
            startTimer()
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }

    private var statusLine: String {
        if session.status == "Conectado" {
            let count = remoteParticipants.count + (localParticipant != nil ? 1 : 0)
            return "\(count) participantes · \(formatDuration(elapsedSeconds))"
        }
        return session.status
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            iconChip(systemName: "chevron.down", action: { hapticTap(); onMinimize() })
            ConnectionQualityBars(quality: session.connectionQuality)
                .frame(width: 22, height: 22)
            Spacer()
            Text(roomName.isEmpty ? "Reunião" : roomName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
                .padding(.horizontal, 8)
            Spacer()
            if hasVideo {
                iconChip(systemName: "camera.rotate.fill", action: { hapticTap(); onSwitchCamera() })
                iconChip(systemName: session.camEnabled ? "video.fill" : "video.slash.fill", action: {
                    let desired = !session.camEnabled
                    session.camEnabled = desired
                    hapticTap()
                    onToggleCam(desired)
                })
            }
        }
    }

    @ViewBuilder
    private func iconChip(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color.black.opacity(0.45))
                    .frame(width: 36, height: 36)
                Image(systemName: systemName)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.white)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Grid

    @ViewBuilder
    private func gridContent(size: CGSize) -> some View {
        let remotes = remoteParticipants
        let count = remotes.count

        if count == 0 {
            waitingState
        } else if count == 1 {
            tile(for: remotes[0], width: size.width, height: size.height)
        } else if count == 2 {
            VStack(spacing: 8) {
                ForEach(remotes) { p in
                    tile(for: p, width: size.width, height: (size.height - 8) / 2)
                }
            }
        } else if count <= 4 {
            adaptiveGrid(remotes: remotes, cols: 2, size: size)
        } else if count <= 6 {
            adaptiveGrid(remotes: remotes, cols: 2, size: size)
        } else if count <= 9 {
            adaptiveGrid(remotes: remotes, cols: 3, size: size)
        } else {
            // 10+ — scrollable 2 columns, fixed aspect
            let cols = Array(repeating: GridItem(.flexible(), spacing: 8), count: 2)
            let tileW = (size.width - 8) / 2
            let tileH = tileW * (4.0 / 3.0)
            ScrollView(.vertical, showsIndicators: false) {
                LazyVGrid(columns: cols, spacing: 8) {
                    ForEach(remotes) { p in
                        tile(for: p, width: tileW, height: tileH)
                    }
                }
            }
        }
    }

    /// 2 or 3-column LazyVGrid sized so all tiles fit on screen at once. Each
    /// tile gets `(size.height - spacing*(rows-1)) / rows` height.
    @ViewBuilder
    private func adaptiveGrid(remotes: [GroupParticipant], cols: Int, size: CGSize) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: cols)
        let rows = ceil(Double(remotes.count) / Double(cols))
        let tileH = max(120, (size.height - CGFloat((rows - 1) * 8)) / CGFloat(rows))
        let tileW = (size.width - CGFloat((cols - 1) * 8)) / CGFloat(cols)
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(remotes) { p in
                tile(for: p, width: tileW, height: tileH)
            }
        }
    }

    private var waitingState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "person.2.fill")
                .font(.system(size: 48))
                .foregroundColor(secondaryText)
            Text("Aguardando outros participantes\u{2026}")
                .font(.system(size: 16))
                .foregroundColor(secondaryText)
            Text(roomName.isEmpty ? "" : roomName)
                .font(.system(size: 13))
                .foregroundColor(secondaryText.opacity(0.7))
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    /// One participant tile. Video or avatar fallback, name pill, mic-muted
    /// badge, hand-raise badge, active-speaker green outline.
    @ViewBuilder
    private func tile(for participant: GroupParticipant,
                      width: CGFloat,
                      height: CGFloat) -> some View {
        ZStack(alignment: .bottomLeading) {
            // Backing layer (video or avatar)
            ZStack {
                if let track = participant.videoTrack {
                    SwiftUIVideoView(track)
                        .frame(width: width, height: height)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(chipColor)
                        .frame(width: width, height: height)
                    // Avatar circle scaled to ~32% of the smaller side
                    let avatarSize = min(width, height) * 0.45
                    ZStack {
                        Circle()
                            .fill(Color.white.opacity(0.08))
                            .frame(width: avatarSize, height: avatarSize)
                        Text(initialFor(participant.name, fallback: participant.identity))
                            .font(.system(size: avatarSize * 0.45, weight: .regular, design: .rounded))
                            .foregroundColor(.white)
                    }
                }
            }

            // Active speaker outline. SwiftUI overlay so the ring sits over
            // the video without re-laying out the tile.
            if participant.isSpeaking {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(speakerRingColor, lineWidth: 3)
                    .frame(width: width, height: height)
            }

            // Name pill (bottom-leading)
            HStack(spacing: 4) {
                if participant.handRaised {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.yellow)
                }
                Text(participant.name.isEmpty ? participant.identity : participant.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.black.opacity(0.5))
            .clipShape(Capsule())
            .padding(8)

            // Mic-muted badge (top-leading)
            if participant.audioMuted {
                VStack {
                    HStack {
                        ZStack {
                            Circle()
                                .fill(Color.black.opacity(0.55))
                                .frame(width: 24, height: 24)
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(.white)
                        }
                        .padding(8)
                        Spacer()
                    }
                    Spacer()
                }
                .frame(width: width, height: height)
            }

            // Connection-quality bars (top-trailing) for tiles in slim
            // signaling. Hidden when quality is full to keep tiles clean.
            if participant.connectionQuality < 3 {
                VStack {
                    HStack {
                        Spacer()
                        ConnectionQualityBars(quality: participant.connectionQuality)
                            .frame(width: 18, height: 18)
                            .padding(.top, 10)
                            .padding(.trailing, 10)
                    }
                    Spacer()
                }
                .frame(width: width, height: height)
            }
        }
        .frame(width: width, height: height)
    }

    // MARK: - Local PiP

    @ViewBuilder
    private func localPreviewTile(_ track: VideoTrack) -> some View {
        let baseWidth: CGFloat = 100
        let baseHeight: CGFloat = 140
        GeometryReader { proxy in
            SwiftUIVideoView(track)
                .frame(width: baseWidth, height: baseHeight)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.white.opacity(0.25), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.4), radius: 8, x: 0, y: 4)
                .offset(
                    x: pipOffset.width + pipDragOffset.width,
                    y: pipOffset.height + pipDragOffset.height
                )
                .position(
                    x: proxy.size.width - baseWidth / 2 - 16,
                    y: baseHeight / 2 + 72
                )
                .gesture(
                    DragGesture()
                        .onChanged { value in pipDragOffset = value.translation }
                        .onEnded { value in
                            let predictedX = proxy.size.width - baseWidth / 2 - 16
                                + pipOffset.width + value.translation.width
                            let snapToRight = predictedX > proxy.size.width / 2
                            let targetX: CGFloat = snapToRight ? 0 : -(proxy.size.width - baseWidth - 32)
                            let predictedY = pipOffset.height + value.translation.height
                            let clampedY = max(0, min(proxy.size.height - baseHeight - 200, predictedY))
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                                pipOffset = CGSize(width: targetX, height: clampedY)
                                pipDragOffset = .zero
                            }
                        }
                )
        }
    }

    // MARK: - Bottom action bar

    private var bottomActionBar: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                actionPillButton(icon: "rectangle.on.rectangle", label: "Compartilhar") {
                    hapticTap(); onScreenShare()
                }
                actionPillButton(icon: "person.badge.plus", label: "Adicionar") {
                    hapticTap(); onAddMember()
                }
                actionPillButton(icon: "ellipsis", label: "Mais") {
                    hapticTap()
                    withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet.toggle() }
                }
                actionPillButton(icon: "face.smiling", label: "Reagir") {
                    hapticTap()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { showEmojiBar.toggle() }
                }
            }

            HStack(spacing: 20) {
                circleButton(
                    size: 60,
                    background: session.micEnabled ? chipColor : Color.white,
                    foreground: session.micEnabled ? .white : .black,
                    systemName: session.micEnabled ? "mic.fill" : "mic.slash.fill"
                ) {
                    let desired = !session.micEnabled
                    session.micEnabled = desired
                    hapticTap()
                    onToggleMute(desired)
                }

                if hasVideo {
                    circleButton(
                        size: 60,
                        background: session.camEnabled ? chipColor : Color.white,
                        foreground: session.camEnabled ? .white : .black,
                        systemName: session.camEnabled ? "video.fill" : "video.slash.fill"
                    ) {
                        let desired = !session.camEnabled
                        session.camEnabled = desired
                        hapticTap()
                        onToggleCam(desired)
                    }
                }

                circleButton(
                    size: 60,
                    background: session.speakerOn ? Color.white : chipColor,
                    foreground: session.speakerOn ? .black : .white,
                    systemName: session.speakerOn ? "speaker.wave.3.fill" : "speaker.fill",
                    onLongPress: { hapticTap(); showAudioPicker = true }
                ) {
                    let desired = !session.speakerOn
                    session.speakerOn = desired
                    hapticTap()
                    onToggleSpeaker(desired)
                }

                circleButton(
                    size: 60,
                    background: session.handRaised ? Color.yellow : chipColor,
                    foreground: session.handRaised ? .black : .white,
                    systemName: "hand.raised.fill"
                ) {
                    let desired = !session.handRaised
                    session.handRaised = desired
                    hapticTap()
                    onHandRaiseToggle(desired)
                }

                circleButton(
                    size: 68,
                    background: hangupColor,
                    foreground: .white,
                    systemName: "phone.down.fill"
                ) {
                    hapticHeavy()
                    onHangup()
                }
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func actionPillButton(
        icon: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(.white)
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white.opacity(0.9))
            }
            .frame(width: 70, height: 56)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(chipColor.opacity(0.85))
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func circleButton(
        size: CGFloat,
        background: Color,
        foreground: Color,
        systemName: String,
        onLongPress: (() -> Void)? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(background)
                    .frame(width: size, height: size)
                Image(systemName: systemName)
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundColor(foreground)
            }
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in onLongPress?() }
        )
    }

    // MARK: - Quick emoji bar

    private let quickEmojis = ["❤️", "👍", "👏", "😂", "🎉", "🔥"]

    private var emojiQuickBar: some View {
        HStack(spacing: 12) {
            ForEach(quickEmojis, id: \.self) { emoji in
                Button(action: {
                    hapticTap()
                    onSendReaction(emoji)
                    withAnimation(.easeOut(duration: 0.2)) { showEmojiBar = false }
                }) {
                    Text(emoji)
                        .font(.system(size: 30))
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(Color.white.opacity(0.12)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Capsule().fill(Color.black.opacity(0.55)))
    }

    // MARK: - More sheet

    private var moreSheetOverlay: some View {
        ZStack {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                }
            VStack(spacing: 0) {
                Spacer()
                VStack(spacing: 12) {
                    Capsule()
                        .fill(Color.white.opacity(0.3))
                        .frame(width: 40, height: 4)
                        .padding(.top, 10)
                    Text("Mais opções")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.bottom, 6)
                    moreRow(icon: "record.circle", title: session.recording ? "Parar gravação" : "Gravar reunião") {
                        session.recording.toggle()
                        withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                    }
                    moreRow(icon: session.onHold ? "play.fill" : "pause.fill", title: session.onHold ? "Retomar" : "Colocar em espera") {
                        session.onHold.toggle()
                        withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                    }
                    moreRow(icon: "person.3.fill", title: "Lista de participantes (\(session.participants.count))") {
                        withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 24)
                        .fill(Color(red: 0x14/255.0, green: 0x1F/255.0, blue: 0x27/255.0))
                )
            }
        }
    }

    private func moreRow(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(.white)
                    .frame(width: 28)
                Text(title)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                Spacer()
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.white.opacity(0.06))
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Audio picker

    private var audioPickerSheet: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.3))
                .frame(width: 40, height: 4)
                .padding(.top, 10)
            Text("Saída de áudio")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.white)
                .padding(.top, 14)
                .padding(.bottom, 8)
            VStack(spacing: 8) {
                audioRouteRow(icon: "speaker.wave.3.fill", title: "Alto-falante", selected: session.speakerOn) {
                    session.speakerOn = true
                    onToggleSpeaker(true)
                    showAudioPicker = false
                }
                audioRouteRow(icon: "iphone", title: "Telefone", selected: !session.speakerOn) {
                    session.speakerOn = false
                    onToggleSpeaker(false)
                    showAudioPicker = false
                }
                audioRouteRow(icon: "headphones", title: "Bluetooth", selected: false) {
                    onToggleSpeaker(false)
                    showAudioPicker = false
                }
            }
            .padding(.horizontal, 20)
            Spacer()
        }
        .background(Color(red: 0x14/255.0, green: 0x1F/255.0, blue: 0x27/255.0))
    }

    @ViewBuilder
    private func audioRouteRow(icon: String, title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .foregroundColor(selected ? speakerRingColor : .white)
                    .frame(width: 28)
                Text(title)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundColor(speakerRingColor)
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.white.opacity(selected ? 0.1 : 0.04))
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Misc

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            guard session.status == "Conectado" else { return }
            elapsedSeconds += 1
        }
    }

    private func initialFor(_ name: String, fallback: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = trimmed.isEmpty ? fallback : trimmed
        guard let first = source.first else { return "?" }
        return String(first).uppercased()
    }

    private func formatDuration(_ secs: Int) -> String {
        let h = secs / 3600
        let m = (secs % 3600) / 60
        let s = secs % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%02d:%02d", m, s)
    }

    private func hapticTap() {
        let gen = UIImpactFeedbackGenerator(style: .light)
        gen.impactOccurred()
    }

    private func hapticHeavy() {
        let gen = UIImpactFeedbackGenerator(style: .heavy)
        gen.impactOccurred()
    }
}
