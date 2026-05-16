import SwiftUI
import UIKit
// [native group call screen, 2026-05-16] Same LiveKit module as the 1:1
// CallView — we need SwiftUIVideoView, VideoTrack, and LocalVideoTrack to
// render each participant tile. Mirrors the Android GroupCallActivity grid.
import LiveKitClient

// [native group call screen, 2026-05-16]
//
// SwiftUI grid that mirrors the Android GroupCallActivity layout. Each
// participant is a tile with their video (SwiftUIVideoView) or an avatar
// fallback, a name overlay at bottom-leading, and a mic-muted badge at
// top-leading. The local participant is rendered as a 96×120 floating
// preview in the top-right corner so it doesn't fight for grid space.
//
// State is driven by an `@ObservedObject GroupCallSessionState` owned by
// GroupCallViewController. The VC mutates the participants array (always
// on the main actor) as LiveKit fires RoomDelegate callbacks, and SwiftUI
// re-renders the grid.
//
// Grid layout rule (matches Android GroupCallActivity):
//   1 remote     → fullscreen single tile
//   2 remotes    → 1 column × 2 rows
//   3-4 remotes  → 2 × 2 grid
//   5+ remotes   → 2 columns, scrollable
//
// "remote" here = participants where `isLocal == false`. The local tile is
// always the floating PiP overlay, never part of the grid (so a 1-on-1
// group call shows the remote fullscreen, not a 2-tile split — same UX as
// WhatsApp / Meet).

/// One row in the SwiftUI grid. Mirrors what GroupCallViewController.swift
/// builds from LiveKit's Participant snapshots. `videoTrack` is non-nil only
/// after the subscriber acked the first video frame; until then we draw the
/// avatar placeholder.
struct GroupParticipant: Identifiable, Equatable {
    let id: String      // backing for Identifiable; mirrors identity
    let identity: String
    let name: String
    let videoTrack: VideoTrack?
    let audioMuted: Bool
    let isLocal: Bool

    static func == (lhs: GroupParticipant, rhs: GroupParticipant) -> Bool {
        // VideoTrack identity is by reference; comparing identity + muted +
        // track ObjectIdentifier is enough for SwiftUI diffing. We never
        // mutate a participant in place — VC builds a fresh array each time.
        guard lhs.identity == rhs.identity else { return false }
        guard lhs.audioMuted == rhs.audioMuted else { return false }
        guard lhs.isLocal == rhs.isLocal else { return false }
        guard lhs.name == rhs.name else { return false }
        switch (lhs.videoTrack, rhs.videoTrack) {
        case (nil, nil): return true
        case (let a?, let b?): return ObjectIdentifier(a) == ObjectIdentifier(b)
        default: return false
        }
    }
}

/// Source of truth for the SwiftUI group-call view. Updated only from the
/// main actor by GroupCallViewController. `status` lights the bottom-center
/// hint text ("Conectando…" → "Conectado").
final class GroupCallSessionState: ObservableObject {
    @Published var participants: [GroupParticipant]
    @Published var status: String
    @Published var micEnabled: Bool
    @Published var camEnabled: Bool

    init(participants: [GroupParticipant] = [],
         status: String = "Conectando\u{2026}",
         micEnabled: Bool = true,
         camEnabled: Bool = true) {
        self.participants = participants
        self.status = status
        self.micEnabled = micEnabled
        self.camEnabled = camEnabled
    }
}

struct GroupCallView: View {
    @ObservedObject var session: GroupCallSessionState
    let hasVideo: Bool

    // Closures wired by the hosting GroupCallViewController. They mirror the
    // 1:1 CallView contract — optimistic flips in SwiftUI, VC owns the
    // suspend setMicrophone / setCamera calls and rolls back on throw.
    let onHangup: () -> Void
    let onToggleMute: (Bool) -> Void
    let onToggleCam: (Bool) -> Void

    // Same palette as the 1:1 CallView so the two screens look like one
    // product. #0B141A bg, #1F2C34 chip, #E53935 hangup, #8696A0 secondary.
    private let backgroundColor = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chipColor       = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let hangupColor     = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)
    private let secondaryText   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)

    private var remoteParticipants: [GroupParticipant] {
        session.participants.filter { !$0.isLocal }
    }

    private var localParticipant: GroupParticipant? {
        session.participants.first(where: { $0.isLocal })
    }

    var body: some View {
        ZStack {
            backgroundColor.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer().frame(height: 60)

                // Grid takes most of the screen. GeometryReader lets us size
                // tiles based on count + available space; we never need
                // pixel-perfect layout, just "close enough to WhatsApp".
                GeometryReader { proxy in
                    gridContent(size: proxy.size)
                }
                .padding(.horizontal, 12)

                // Status text — flips from "Conectando…" once the room reports
                // roomDidConnect or the first remote participant joins.
                Text(session.status)
                    .font(.system(size: 14))
                    .foregroundColor(secondaryText)
                    .padding(.top, 8)

                Spacer().frame(height: 16)

                // Controls row: mute / cam (only if video) / hangup. Wider
                // touch targets than the 1:1 screen because the grid pushes
                // them closer to the bottom safe-area inset.
                HStack(spacing: 28) {
                    controlButton(
                        size: 60,
                        background: chipColor,
                        enabled: session.micEnabled,
                        systemName: session.micEnabled ? "mic.fill" : "mic.slash.fill"
                    ) {
                        let desired = !session.micEnabled
                        session.micEnabled = desired
                        onToggleMute(desired)
                    }

                    if hasVideo {
                        controlButton(
                            size: 60,
                            background: chipColor,
                            enabled: session.camEnabled,
                            systemName: session.camEnabled ? "video.fill" : "video.slash.fill"
                        ) {
                            let desired = !session.camEnabled
                            session.camEnabled = desired
                            onToggleCam(desired)
                        }
                    }

                    controlButton(
                        size: 68,
                        background: hangupColor,
                        enabled: true,
                        systemName: "phone.down.fill"
                    ) {
                        onHangup()
                    }
                }
                .padding(.bottom, 36)
            }

            // Local participant PiP — top-right floating tile. Hidden until
            // the local camera has actually published (videoTrack non-nil) so
            // we don't show a black square. For audio-only group calls, the
            // local tile stays hidden entirely (matches WhatsApp).
            if hasVideo, let local = localParticipant, let track = local.videoTrack {
                VStack {
                    HStack {
                        Spacer()
                        SwiftUIVideoView(track)
                            .frame(width: 96, height: 120)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(Color.white.opacity(0.2), lineWidth: 1)
                            )
                            .padding(.top, 60)
                            .padding(.trailing, 16)
                    }
                    Spacer()
                }
            }
        }
    }

    // MARK: - Grid

    /// Picks between fullscreen, 1-col, 2×2, or 2-col-scroll based on the
    /// number of remote participants. Returns an erased view via @ViewBuilder
    /// so each branch can be its own SwiftUI shape (LazyVGrid vs single).
    @ViewBuilder
    private func gridContent(size: CGSize) -> some View {
        let remotes = remoteParticipants
        let count = remotes.count

        if count == 0 {
            // Empty state — the local user is alone in the room. Show a soft
            // hint so the screen isn't a black void while the others join.
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "person.2.fill")
                    .font(.system(size: 48))
                    .foregroundColor(secondaryText)
                Text("Aguardando outros participantes\u{2026}")
                    .font(.system(size: 16))
                    .foregroundColor(secondaryText)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        } else if count == 1 {
            // 1 remote = fullscreen. WhatsApp/Meet behavior.
            tile(for: remotes[0], width: size.width, height: size.height)
        } else if count == 2 {
            // 1 column × 2 rows. Each tile takes half the height.
            VStack(spacing: 8) {
                ForEach(remotes) { p in
                    tile(for: p, width: size.width, height: (size.height - 8) / 2)
                }
            }
        } else if count <= 4 {
            // 2 × 2 grid. LazyVGrid with two fixed columns; row height is
            // half the available space minus the inter-row spacing.
            let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
            let rows = ceil(Double(count) / 2.0)
            let tileH = (size.height - CGFloat((rows - 1) * 8)) / CGFloat(rows)
            LazyVGrid(columns: cols, spacing: 8) {
                ForEach(remotes) { p in
                    tile(for: p, width: (size.width - 8) / 2, height: tileH)
                }
            }
        } else {
            // 5+ remotes — 2 columns, vertically scrollable. Tile aspect ratio
            // pinned to 3:4 so adjacent tiles look balanced regardless of
            // total count.
            let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
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

    /// Build a single participant tile. The SwiftUIVideoView (or avatar
    /// fallback) fills the rectangle; overlays add the name pill and the
    /// mic-muted badge. Sized explicitly so LazyVGrid measurements are
    /// stable across re-renders.
    @ViewBuilder
    private func tile(for participant: GroupParticipant,
                      width: CGFloat,
                      height: CGFloat) -> some View {
        ZStack(alignment: .bottomLeading) {
            ZStack {
                if let track = participant.videoTrack {
                    SwiftUIVideoView(track)
                        .frame(width: width, height: height)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    // Avatar placeholder. Mirrors the 1:1 CallView circle but
                    // sized down so it stays centered in the tile regardless
                    // of the grid layout chosen above.
                    RoundedRectangle(cornerRadius: 12)
                        .fill(chipColor)
                        .frame(width: width, height: height)
                    Text(initialFor(participant.name, fallback: participant.identity))
                        .font(.system(size: min(width, height) * 0.32,
                                      weight: .regular))
                        .foregroundColor(.white)
                }
            }

            // Name pill — bottom-leading, dark translucent background so it's
            // readable over both the video feed and the avatar fallback.
            HStack(spacing: 4) {
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

            // Mic-muted badge — top-leading. Only rendered when audioMuted is
            // true. Same red as the hangup button so it's visually consistent.
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
        }
        .frame(width: width, height: height)
    }

    // MARK: - Helpers

    private func initialFor(_ name: String, fallback: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = trimmed.isEmpty ? fallback : trimmed
        guard let first = source.first else { return "?" }
        return String(first).uppercased()
    }

    @ViewBuilder
    private func controlButton(
        size: CGFloat,
        background: Color,
        enabled: Bool,
        systemName: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(background)
                    .frame(width: size, height: size)
                Image(systemName: systemName)
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundColor(.white)
            }
            .opacity(enabled ? 1.0 : 0.5)
        }
        .buttonStyle(.plain)
    }
}
