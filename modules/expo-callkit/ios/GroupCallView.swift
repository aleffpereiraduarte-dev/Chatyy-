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
//   * Layout rule matches WhatsApp 2025 (cap 32 participants):
//       0 remotes   → "waiting" placeholder
//       1 remote    → fullscreen single tile (the local preview floats)
//       2 remotes   → 1 col × 2 rows
//       3-4 remotes → 2 × 2 grid
//       5-9 remotes → 3 columns ([2026-10-14 group-ui] was 2 cols for 5-6)
//       10-32       → scrollable 2-col LazyVGrid (WhatsApp parity)
//     (grid = GroupGridView, shared with the 1:1 screen's 3+ grid mode;
//      screen shares get their own tile, highlighted on top.)
//   * SF Symbols only.
//   * pt-BR strings.

/// Hard cap on participants per group call. WhatsApp 2025 = 32. Bumped from
/// 9 (2026-05-17) to match parity audit `/tmp/gap_calls_whatsapp.md` item P1#14.
/// Used by the backend invite check and the JS-side participant-picker.
public let kMaxCallParticipants: Int = 32

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
    /// [2026-10-14 group-ui] Dedicated tile for someone's SCREEN SHARE
    /// (identity = "screen:<owner identity>"), shown next to their camera.
    let isScreen: Bool
    /// [2026-10-14 group-ui] Invited / still ringing (no media yet) →
    /// avatar + name + "Tocando…".
    let isRinging: Bool

    init(id: String,
         identity: String,
         name: String,
         videoTrack: VideoTrack? = nil,
         audioMuted: Bool = false,
         isLocal: Bool = false,
         isSpeaking: Bool = false,
         handRaised: Bool = false,
         connectionQuality: Int = 3,
         isScreen: Bool = false,
         isRinging: Bool = false) {
        self.id = id
        self.identity = identity
        self.name = name
        self.videoTrack = videoTrack
        self.audioMuted = audioMuted
        self.isLocal = isLocal
        self.isSpeaking = isSpeaking
        self.handRaised = handRaised
        self.connectionQuality = connectionQuality
        self.isScreen = isScreen
        self.isRinging = isRinging
    }

    /// "screen:" prefix of screen-share tile identities.
    static let screenPrefix = "screen:"

    static func == (lhs: GroupParticipant, rhs: GroupParticipant) -> Bool {
        guard lhs.identity == rhs.identity else { return false }
        guard lhs.audioMuted == rhs.audioMuted else { return false }
        guard lhs.isLocal == rhs.isLocal else { return false }
        guard lhs.name == rhs.name else { return false }
        guard lhs.isSpeaking == rhs.isSpeaking else { return false }
        guard lhs.handRaised == rhs.handRaised else { return false }
        guard lhs.connectionQuality == rhs.connectionQuality else { return false }
        guard lhs.isScreen == rhs.isScreen, lhs.isRinging == rhs.isRinging else { return false }
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
    /// [2026-10-09 native-group-call] Tile pinned in spotlight (tap to toggle).
    @Published var pinnedIdentity: String?
    /// Last remote dominant speaker reported by LiveKit.
    @Published var dominantSpeaker: String?
    /// [2026-10-14 group-ui] Discreet top notice ("Fulano entrou / saiu").
    @Published var toast: String?
    /// [2026-10-14 group-ui] Screen-share tile opened full screen (tile `id`).
    @Published var fullscreenId: String?
    /// [2026-10-15 screen-share whatsapp-level] I am sharing my screen →
    /// top pill "Você está compartilhando a tela · Parar".
    @Published var localScreenSharing: Bool = false

    init(participants: [GroupParticipant] = [],
         status: String = GroupCallStrings.connecting,
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
        self.pinnedIdentity = nil
        self.dominantSpeaker = nil
        self.toast = nil
        self.fullscreenId = nil
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
    /// [2026-10-09 native-group-call] Tap a tile → pin/unpin it in spotlight.
    var onTogglePin: (String) -> Void = { _ in }
    /// [2026-10-11 ongoing-call] "Mensagem" shortcut (nil = hidden).
    var onOpenChat: (() -> Void)? = nil
    /// [2026-10-16 wave13-B efeitos] "Efeitos" (fundo + luz) row in Mais
    /// opções (nil = hidden — kill switch).
    var onEffects: (() -> Void)? = nil

    // Local UI state
    @State private var showAudioPicker = false
    @State private var showEmojiBar = false
    @State private var showMoreSheet = false
    /// [2026-10-14 group-ui] Participant list sheet (name · state · Adicionar).
    @State private var showParticipants = false
    @State private var pipOffset: CGSize = .zero
    @State private var pipDragOffset: CGSize = .zero
    @State private var elapsedSeconds = 0
    @State private var timer: Timer?

    // Palette (same as the 1:1 CallView so the two feel like one product)
    // [2026-10-09 native-group-call] Monochrome (app is black & white).
    private let backgroundColor = Color.black
    private let chipColor       = Color(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0)
    private let hangupColor     = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)
    private let secondaryText   = Color(white: 0.62)
    private let speakerRingColor = Color.white

    private var remoteParticipants: [GroupParticipant] {
        session.participants.filter { !$0.isLocal }
    }

    private var localParticipant: GroupParticipant? {
        session.participants.first(where: { $0.isLocal })
    }

    /// People tiles (local + remotes + ringing), screen-share tiles excluded.
    private var participantCount: Int {
        session.participants.filter { !$0.isScreen }.count
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
                // [2026-10-14 group-ui] Shared grid (also used by the 1:1 screen
                // when a 3rd person joins): screen-share tiles, ringing tiles,
                // full-screen screen viewer with pinch.
                GroupGridView(session: session, waitingSubtitle: roomName, onTogglePin: onTogglePin)
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
            // Second sheet on a different view than the audio picker (two
            // `.sheet` on one view = only the last one works on iOS 14/15).
            .sheet(isPresented: $showParticipants) {
                GroupParticipantsSheet(
                    session: session,
                    onAdd: {
                        showParticipants = false
                        // Let the sheet finish dismissing before the VC presents
                        // the contact picker (one presentation at a time).
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { onAddMember() }
                    },
                    onClose: { showParticipants = false }
                )
            }

            // Local PiP — floats over the grid, draggable. Hidden when no
            // video or local camera is off / not published yet.
            // [2026-10-15 cam-1-toque] Also a VOICE group call whose camera
            // was turned on mid-call.
            if hasVideo || session.camEnabled, let local = localParticipant, let track = local.videoTrack {
                localPreviewTile(track)
            }

            // Floating reactions
            ZStack {
                ForEach(session.floatingReactions) { reaction in
                    FloatingEmojiView(reaction: reaction)
                }
            }
            .allowsHitTesting(false)

            // [2026-10-15 screen-share whatsapp-level] Local share pill.
            if session.localScreenSharing {
                VStack {
                    LocalScreenSharePill(onStop: { hapticTap(); onScreenShare() })
                        .padding(.top, 56)
                    Spacer()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            // [2026-10-14 group-ui] "Fulano entrou / saiu" — discreet top pill.
            if let toast = session.toast {
                VStack {
                    CallToastPill(text: toast)
                        .padding(.top, 60)
                    Spacer()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
                .allowsHitTesting(false)
            }

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
        .animation(.easeInOut(duration: 0.25), value: session.toast)
        .animation(.easeInOut(duration: 0.25), value: session.localScreenSharing)
        .sheet(isPresented: $showAudioPicker) {
            Group {
                if #available(iOS 16.0, *) {
                    audioPickerSheet.presentationDetents([.height(280)])
                } else {
                    audioPickerSheet
                }
            }
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
        // [2026-10-11 full-hd] WhatsApp "Conexão fraca" (local POOR/LOST) —
        // same text as the 1:1 pill and Android GroupCallActivity.
        if session.status == GroupCallStrings.connected && session.connectionQuality <= 1 {
            return CallStrings.s("weakConnection")
        }
        if session.status == GroupCallStrings.connected {
            // People in the call: no screen-share tiles, no one still ringing.
            let inCall = remoteParticipants.filter { !$0.isScreen && !$0.isRinging }.count
            let count = inCall + (localParticipant != nil ? 1 : 0)
            return "\(GroupCallStrings.participants(count)) · \(formatDuration(elapsedSeconds))"
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
            Text(roomName.isEmpty ? GroupCallStrings.meeting : roomName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
                .padding(.horizontal, 8)
            Spacer()
            // [2026-10-14 group-ui] Participants (WhatsApp top-right people icon).
            iconChip(systemName: "person.2.fill", action: { hapticTap(); showParticipants = true })
                .accessibilityLabel(Text(GroupCallStrings.participantsList(participantCount)))
            if let openChat = onOpenChat {
                iconChip(systemName: "message.fill", action: { hapticTap(); openChat() })
                    .accessibilityLabel(Text(OngoingCallStrings.message))
            }
            if hasVideo || session.camEnabled {
                iconChip(systemName: "camera.rotate.fill", action: { hapticTap(); onSwitchCamera() })
                // [2026-10-14 group-ui] Camera on/off chip removed here (same
                // toggle is in the bottom bar) — room for the participants chip.
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
            // [2026-10-11 ongoing-call] 44pt hit area around the 36pt chip.
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                actionPillButton(icon: "rectangle.on.rectangle", label: GroupCallStrings.share) {
                    hapticTap(); onScreenShare()
                }
                actionPillButton(icon: "person.badge.plus", label: GroupCallStrings.add) {
                    hapticTap(); onAddMember()
                }
                actionPillButton(icon: "ellipsis", label: GroupCallStrings.more) {
                    hapticTap()
                    withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet.toggle() }
                }
                actionPillButton(icon: "face.smiling", label: GroupCallStrings.react) {
                    hapticTap()
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { showEmojiBar.toggle() }
                }
            }

            // [2026-10-15 cam-1-toque] 10pt (was 20): five buttons now in voice
            // calls too — 4×60 + 68 + 4×10 = 348pt fits 390/393pt screens
            // (minus the 16pt side padding) and nearly a 375pt one.
            HStack(spacing: 10) {
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

                // [2026-10-15 cam-1-toque] Camera button in VOICE group calls
                // too (WhatsApp): 1 tap turns it on mid-call.
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
                    background: session.handRaised ? Color.white : chipColor,
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

    // [reaction bar, 2026-05-17] 5 emojis — matches 1:1 CallView, Android
    // CallActivity, and the JS /call.js fallback. WhatsApp 2025 parity.
    private let quickEmojis = ["❤️", "👍", "👏", "😂", "🎉"]

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
                    Text(GroupCallStrings.moreOptions)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.bottom, 6)
                    // [2026-10-09 native-group-call] "Gravar" / "Em espera"
                    // rows removed — they only flipped a local flag (no real
                    // recording / hold behind them).
                    // [2026-10-14 group-ui] Opens the real participant list
                    // (was a no-op row).
                    moreRow(icon: "person.3.fill", title: GroupCallStrings.participantsList(participantCount)) {
                        withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { showParticipants = true }
                    }
                    if let fx = onEffects, hasVideo || session.camEnabled {
                        moreRow(icon: "wand.and.stars", title: CallFxStrings.s("title")) {
                            withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { fx() }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 24)
                        .fill(Color(red: 0x12/255.0, green: 0x12/255.0, blue: 0x12/255.0))
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
            Text(GroupCallStrings.audioOutput)
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.white)
                .padding(.top, 14)
                .padding(.bottom, 8)
            VStack(spacing: 8) {
                audioRouteRow(icon: "speaker.wave.3.fill", title: GroupCallStrings.speaker, selected: session.speakerOn) {
                    session.speakerOn = true
                    onToggleSpeaker(true)
                    showAudioPicker = false
                }
                audioRouteRow(icon: "iphone", title: GroupCallStrings.phone, selected: !session.speakerOn) {
                    session.speakerOn = false
                    onToggleSpeaker(false)
                    showAudioPicker = false
                }
                audioRouteRow(icon: "headphones", title: GroupCallStrings.bluetooth, selected: false) {
                    onToggleSpeaker(false)
                    showAudioPicker = false
                }
            }
            .padding(.horizontal, 20)
            Spacer()
        }
        .background(Color(red: 0x12/255.0, green: 0x12/255.0, blue: 0x12/255.0))
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
            guard session.status == GroupCallStrings.connected else { return }
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

// MARK: - [2026-10-14 group-ui] Shared grid

/// Adaptive participant grid shared by the group screen (GroupCallView) and
/// the 1:1 screen once a 3rd person joins (CallViewController grid mode).
/// Remote tiles only (the local camera floats on top):
///   0 → waiting · 1 → full · 2 → stacked · 3-4 → 2×2 · 5-9 → 3 columns ·
///   10+ → 2-column scroll.
/// A screen share gets its OWN tile (next to the person's camera); it — or a
/// tile the user pinned — goes big on top with the rest in a filmstrip.
/// Tapping the screen tile opens it full screen (pinch to zoom, drag to pan).
struct GroupGridView: View {
    @ObservedObject var session: GroupCallSessionState
    var waitingSubtitle: String = ""
    var onTogglePin: (String) -> Void = { _ in }

    private let secondaryText = Color(white: 0.62)

    private var remotes: [GroupParticipant] {
        session.participants.filter { !$0.isLocal }
    }

    private var fullscreenBinding: Binding<Bool> {
        Binding(
            get: { session.fullscreenId != nil },
            set: { open in if !open { session.fullscreenId = nil } }
        )
    }

    var body: some View {
        GeometryReader { proxy in
            gridContent(size: proxy.size)
        }
        .fullScreenCover(isPresented: fullscreenBinding) {
            fullscreenContent
        }
    }

    @ViewBuilder
    private var fullscreenContent: some View {
        if let fid = session.fullscreenId,
           let p = session.participants.first(where: { $0.id == fid }),
           let track = p.videoTrack {
            ScreenShareFullscreenView(track: track, title: p.name, onClose: { session.fullscreenId = nil })
        } else {
            // The share ended while it was open → close the viewer.
            Color.black
                .ignoresSafeArea()
                .onAppear { session.fullscreenId = nil }
        }
    }

    /// Pinned tile wins; otherwise the first live screen share is highlighted.
    private func spotlightFocus(_ list: [GroupParticipant]) -> GroupParticipant? {
        if let pinned = session.pinnedIdentity,
           let p = list.first(where: { $0.identity == pinned }) {
            return p
        }
        return list.first(where: { $0.isScreen && $0.videoTrack != nil })
    }

    @ViewBuilder
    private func gridContent(size: CGSize) -> some View {
        let list = remotes
        let count = list.count

        if count == 0 {
            waitingState
        } else if count >= 2, let focus = spotlightFocus(list) {
            spotlightLayout(focus: focus, others: list.filter { $0.id != focus.id }, size: size)
        } else if count == 1 {
            tile(for: list[0], width: size.width, height: size.height)
        } else if count == 2 {
            VStack(spacing: 8) {
                ForEach(list) { p in
                    tile(for: p, width: size.width, height: (size.height - 8) / 2)
                }
            }
        } else if count <= 4 {
            adaptiveGrid(list, cols: 2, size: size)
        } else if count <= 9 {
            adaptiveGrid(list, cols: 3, size: size)
        } else {
            // 10-32 — scrollable 2-column grid (WhatsApp parity).
            let cols = Array(repeating: GridItem(.flexible(), spacing: 8), count: 2)
            let tileW = (size.width - 8) / 2
            let tileH = tileW * (4.0 / 3.0)
            ScrollView(.vertical, showsIndicators: false) {
                LazyVGrid(columns: cols, spacing: 8) {
                    ForEach(list.prefix(kMaxCallParticipants)) { p in
                        tile(for: p, width: tileW, height: tileH)
                    }
                }
            }
        }
    }

    /// Spotlight: focus tile big on top, the rest in a horizontal filmstrip
    /// (adaptiveStream gives the small views the low simulcast layer).
    @ViewBuilder
    private func spotlightLayout(focus: GroupParticipant, others: [GroupParticipant], size: CGSize) -> some View {
        let stripH: CGFloat = min(150, max(96, size.height * 0.22))
        let stripW: CGFloat = stripH * 0.75
        VStack(spacing: 8) {
            tile(for: focus, width: size.width, height: max(120, size.height - stripH - 8))
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(others) { p in
                        tile(for: p, width: stripW, height: stripH)
                    }
                }
            }
            .frame(height: stripH)
        }
    }

    /// 2 or 3 columns sized so every tile fits on screen at once.
    @ViewBuilder
    private func adaptiveGrid(_ list: [GroupParticipant], cols: Int, size: CGSize) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: cols)
        let rows = ceil(Double(list.count) / Double(cols))
        let tileH = max(110, (size.height - CGFloat((rows - 1) * 8)) / CGFloat(rows))
        let tileW = (size.width - CGFloat((cols - 1) * 8)) / CGFloat(cols)
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(list) { p in
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
            Text(GroupCallStrings.waitingOthers)
                .font(.system(size: 16))
                .foregroundColor(secondaryText)
            Text(waitingSubtitle)
                .font(.system(size: 13))
                .foregroundColor(secondaryText.opacity(0.7))
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func tile(for p: GroupParticipant, width: CGFloat, height: CGFloat) -> some View {
        GroupTileView(participant: p,
                      width: width,
                      height: height,
                      pinned: session.pinnedIdentity == p.identity)
            .onTapGesture {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                if p.isScreen && p.videoTrack != nil {
                    session.fullscreenId = p.id
                } else if !p.isRinging {
                    onTogglePin(p.identity)
                }
            }
    }
}

/// One tile: video (camera = fill, screen = fit on black) or avatar, name
/// pill, mic-muted badge, hand, quality bars, pinned marker, white ring while
/// speaking, "Tocando…" for invitees that did not answer yet.
struct GroupTileView: View {
    let participant: GroupParticipant
    let width: CGFloat
    let height: CGFloat
    var pinned: Bool = false

    private let chipColor = Color(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0)

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            backing

            if participant.isSpeaking && !participant.isRinging {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.white, lineWidth: 3)
                    .frame(width: width, height: height)
            }

            if !participant.isRinging {
                namePill.padding(8)
            }

            if participant.audioMuted && !participant.isScreen && !participant.isRinging {
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

            if participant.connectionQuality < 3 && !participant.isScreen && !participant.isRinging {
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

            if pinned {
                VStack {
                    HStack {
                        Spacer()
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(6)
                            .background(Circle().fill(Color.black.opacity(0.55)))
                            .padding(.top, participant.connectionQuality < 3 ? 34 : 8)
                            .padding(.trailing, 8)
                    }
                    Spacer()
                }
                .frame(width: width, height: height)
            }
        }
        .frame(width: width, height: height)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var backing: some View {
        if let track = participant.videoTrack, !participant.isRinging {
            ZStack {
                if participant.isScreen {
                    Color.black
                }
                SwiftUIVideoView(track, layoutMode: participant.isScreen ? .fit : .fill)
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            let avatarSize = min(width, height) * (participant.isRinging ? 0.36 : 0.45)
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(chipColor)
                    .frame(width: width, height: height)
                VStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(Color.white.opacity(0.08))
                            .frame(width: avatarSize, height: avatarSize)
                        Text(Self.initial(participant.name, fallback: participant.identity))
                            .font(.system(size: avatarSize * 0.45, weight: .regular, design: .rounded))
                            .foregroundColor(.white)
                    }
                    if participant.isRinging {
                        Text(participant.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                        Text(CallStrings.s("ringing"))
                            .font(.system(size: 12))
                            .foregroundColor(Color(white: 0.62))
                    }
                }
            }
            .opacity(participant.isRinging ? 0.85 : 1)
        }
    }

    private var namePill: some View {
        HStack(spacing: 4) {
            if participant.isScreen {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.white)
            }
            if participant.handRaised {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
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
    }

    static func initial(_ name: String, fallback: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = trimmed.isEmpty ? fallback : trimmed
        guard let first = source.first else { return "?" }
        return String(first).uppercased()
    }
}

/// [2026-10-14 group-ui] Someone's shared screen full screen: aspect-fit,
/// pinch to zoom (1×–4×), drag to pan while zoomed, double tap 1×↔2×.
struct ScreenShareFullscreenView: View {
    let track: VideoTrack
    let title: String
    let onClose: () -> Void

    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    // [2026-10-15 screen-share whatsapp-level] Landscape while the iPhone
    // UI stays portrait-locked: device turned sideways → the content is laid
    // out in a height×width frame and rotated ±90° (rotation lock honoured —
    // UIDevice then keeps reporting portrait).
    @State private var angle: Double = 0

    var body: some View {
        GeometryReader { geo in
            let rotated = angle != 0
            content
                .frame(width: rotated ? geo.size.height : geo.size.width,
                       height: rotated ? geo.size.width : geo.size.height)
                .rotationEffect(.degrees(angle))
                .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .ignoresSafeArea()
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear {
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            updateAngle()
        }
        .onDisappear {
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
            updateAngle()
        }
    }

    private func updateAngle() {
        let next: Double
        switch UIDevice.current.orientation {
        case .landscapeLeft: next = 90
        case .landscapeRight: next = -90
        case .portrait, .portraitUpsideDown: next = 0
        default: return
        }
        guard next != angle else { return }
        withAnimation(.easeInOut(duration: 0.3)) {
            reset()
            angle = next
        }
    }

    private var content: some View {
        ZStack(alignment: .top) {
            Color.black

            SwiftUIVideoView(track, layoutMode: .fit)
                .scaleEffect(scale)
                .offset(offset)
                .contentShape(Rectangle())
                .gesture(zoomPan)
                .onTapGesture(count: 2) {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        if scale > 1.01 {
                            reset()
                        } else {
                            scale = 2
                            lastScale = 2
                        }
                    }
                }

            HStack(spacing: 12) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.black.opacity(0.55)))
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Color.black.opacity(0.55)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(GroupCallStrings.s("pk.close")))
            }
            .padding(.horizontal, angle != 0 ? 28 : 16)
            .padding(.top, angle != 0 ? 16 : 56)
        }
        .clipped()
    }

    private var zoomPan: some Gesture {
        MagnificationGesture()
            .onChanged { v in
                scale = min(max(lastScale * v, 1), 4)
            }
            .onEnded { _ in
                lastScale = scale
                if scale <= 1.01 {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { reset() }
                }
            }
            .simultaneously(with:
                DragGesture()
                    .onChanged { v in
                        guard scale > 1.01 else { return }
                        offset = CGSize(width: lastOffset.width + v.translation.width,
                                        height: lastOffset.height + v.translation.height)
                    }
                    .onEnded { _ in
                        lastOffset = offset
                    }
            )
    }

    private func reset() {
        scale = 1
        lastScale = 1
        offset = .zero
        lastOffset = .zero
    }
}

/// [2026-10-14 group-ui] Participant list: avatar · name · state
/// (Tocando… / Conectado / Mudo) + "Adicionar".
struct GroupParticipantsSheet: View {
    @ObservedObject var session: GroupCallSessionState
    let onAdd: () -> Void
    let onClose: () -> Void

    private var rows: [GroupParticipant] {
        let people = session.participants.filter { !$0.isScreen }
        let locals = people.filter { $0.isLocal }
        let live = people.filter { !$0.isLocal && !$0.isRinging }
        let ringing = people.filter { !$0.isLocal && $0.isRinging }
        return locals + live + ringing
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.3))
                .frame(width: 40, height: 4)
                .padding(.top, 10)
            HStack(spacing: 12) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(GroupCallStrings.s("pk.close")))
                Text(GroupCallStrings.participantsList(rows.count))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Spacer()
                Button(action: onAdd) {
                    HStack(spacing: 6) {
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 14, weight: .semibold))
                        Text(GroupCallStrings.add)
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundColor(.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.white))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { p in
                        row(p)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .background(Color(white: 0.07).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func stateText(_ p: GroupParticipant) -> String {
        if p.isRinging { return CallStrings.s("ringing") }
        if p.audioMuted { return GroupCallStrings.s("gx.muted") }
        return GroupCallStrings.connected
    }

    private func row(_ p: GroupParticipant) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.1))
                    .frame(width: 44, height: 44)
                Text(GroupTileView.initial(p.name, fallback: p.identity))
                    .font(.system(size: 18, weight: .medium, design: .rounded))
                    .foregroundColor(.white)
            }
            .overlay(
                Circle()
                    .stroke(Color.white, lineWidth: p.isSpeaking ? 2 : 0)
                    .frame(width: 46, height: 46)
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name.isEmpty ? p.identity : p.name)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Text(stateText(p))
                    .font(.system(size: 13))
                    .foregroundColor(Color(white: 0.62))
                    .lineLimit(1)
            }
            Spacer()
            if p.isRinging {
                Image(systemName: "phone.arrow.up.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(Color(white: 0.62))
            } else if p.audioMuted {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
            } else if p.handRaised {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .opacity(p.isRinging ? 0.8 : 1)
    }
}

/// [2026-10-14 group-ui] Discreet top notice ("Fulano entrou / saiu").
/// [2026-10-15 screen-share whatsapp-level] "Você está compartilhando a
/// tela" + Parar (green, same look as the 1:1 chip).
struct LocalScreenSharePill: View {
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.on.rectangle")
                .font(.system(size: 13, weight: .semibold))
            Text(CallStrings.s("ssYouAreSharing"))
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            Button(action: onStop) {
                Text(CallStrings.s("stop"))
                    .font(.system(size: 13, weight: .bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Color.white.opacity(0.22)))
            }
            .buttonStyle(.plain)
        }
        .foregroundColor(.white)
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(height: 36)
        .background(Capsule().fill(Color(red: 0x1C / 255.0, green: 0x1C / 255.0, blue: 0x1E / 255.0).opacity(0.96)))
        .padding(.horizontal, 16)
    }
}

struct CallToastPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundColor(.white)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.black.opacity(0.72)))
            .overlay(Capsule().stroke(Color.white.opacity(0.14), lineWidth: 0.5))
    }
}
