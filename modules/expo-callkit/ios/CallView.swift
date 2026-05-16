import SwiftUI
import UIKit
// [Day 3, 2026-05-16] CallView now hosts video views (local preview +
// remote tile) so it needs the LiveKit module for SwiftUIVideoView,
// VideoTrack, and LocalVideoTrack types.
import LiveKitClient

// [native call screen, 2026-05-16] SwiftUI view that mirrors the Android
// CallActivity layout (avatar circle + name + status + mute/hangup/video).
//
// [Day 2, 2026-05-16] Mic state + connection status migrated from local
// @State to an @ObservedObject (CallSessionState — declared in
// CallViewController.swift). The mute button still toggles optimistically
// for snappy UX, but the source of truth is now the VC's session object
// and the suspend setMicrophone call runs inside `onToggleMute`.
struct CallView: View {
    // Initial params passed from the hosting UIViewController. Stored as
    // immutable `let` because they describe the call we were launched with.
    let callId: String
    let callerName: String
    let callerEmail: String
    let hasVideo: Bool

    // [Day 2, 2026-05-16] Source of truth for mic + connection status.
    // CallViewController owns the instance; this view re-renders whenever
    // the VC flips status to "Conectado" (after roomDidConnect) or rolls
    // back micEnabled because setMicrophone threw.
    @ObservedObject var session: CallSessionState

    // Closure invoked when the user taps the red hangup button. The hosting
    // CallViewController passes a closure that dismisses itself and posts
    // ExpoCallKitNativeCallEnded so the module can re-emit onCallEnded to JS.
    let onHangup: () -> Void

    // [Day 2, 2026-05-16] Closure invoked with the *desired* mic state
    // after the optimistic UI flip. The VC runs the suspend
    // localParticipant.setMicrophone(enabled:) inside a Task and rolls back
    // session.micEnabled on failure.
    let onToggleMute: (Bool) -> Void

    // [Day 3, 2026-05-16] Camera toggle closure — symmetric with
    // onToggleMute. CallView flips session.camEnabled optimistically; VC
    // calls setCamera(enabled:) and rolls back the @Published on throw.
    let onToggleCam: (Bool) -> Void

    // Background and palette match WhatsApp's dark call screen, same hex
    // values the Android CallActivity uses (#0B141A bg, #1F2C34 chips,
    // #E53935 hangup, #8696A0 secondary text).
    private let backgroundColor = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chipColor       = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let hangupColor     = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)
    private let secondaryText   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)

    var body: some View {
        ZStack {
            // [Day 3, 2026-05-16] For video calls, the remote feed (once
            // subscribed) fills the entire ZStack as the background; until
            // it arrives we keep the dark color so the avatar still shows.
            // Audio calls always keep the dark color.
            if hasVideo, let remote = session.remoteVideoTrack {
                SwiftUIVideoView(remote)
                    .ignoresSafeArea()
            } else {
                backgroundColor
                    .ignoresSafeArea()
            }

            VStack(spacing: 0) {
                Spacer().frame(height: 80)

                // Avatar circle (120pt) — only for audio calls, or for
                // video calls while the remote feed hasn't arrived yet.
                // Once the remote VideoTrack is published, the full-screen
                // video replaces it and we hide the avatar to avoid the
                // overlay covering the remote face.
                if !hasVideo || session.remoteVideoTrack == nil {
                    ZStack {
                        Circle()
                            .fill(chipColor)
                            .frame(width: 120, height: 120)
                        Text(initialFor(callerName))
                            .font(.system(size: 48, weight: .regular))
                            .foregroundColor(.white)
                    }
                    .padding(.bottom, 24)
                }

                Text(callerName.isEmpty ? callerEmail : callerName)
                    .font(.system(size: 24, weight: .regular))
                    .foregroundColor(.white)
                    .padding(.bottom, 8)

                // [Day 2, 2026-05-16] Status text now reads from the shared
                // session object — flips from "Conectando…" to "Conectado"
                // when roomDidConnect fires on the VC.
                Text(session.status)
                    .font(.system(size: 16))
                    .foregroundColor(secondaryText)

                Spacer()

                // Controls row — mute, hangup, and (optionally) video.
                HStack(spacing: 28) {
                    controlButton(
                        size: 64,
                        background: chipColor,
                        enabled: session.micEnabled,
                        systemName: session.micEnabled ? "mic.fill" : "mic.slash.fill"
                    ) {
                        // Optimistic flip — VC will roll back if the
                        // suspend setMicrophone call throws.
                        let desired = !session.micEnabled
                        session.micEnabled = desired
                        print("[CallView] mute toggled — desired=\(desired) callId=\(callId)")
                        onToggleMute(desired)
                    }

                    controlButton(
                        size: 72,
                        background: hangupColor,
                        enabled: true,
                        systemName: "phone.down.fill"
                    ) {
                        print("[CallView] hangup tapped — callId=\(callId)")
                        onHangup()
                    }

                    if hasVideo {
                        controlButton(
                            size: 64,
                            background: chipColor,
                            enabled: session.camEnabled,
                            systemName: session.camEnabled ? "video.fill" : "video.slash.fill"
                        ) {
                            // [Day 3, 2026-05-16] Optimistic flip — VC
                            // rolls back session.camEnabled on throw.
                            let desired = !session.camEnabled
                            session.camEnabled = desired
                            print("[CallView] video toggled — desired=\(desired) callId=\(callId)")
                            onToggleCam(desired)
                        }
                    }
                }
                .padding(.bottom, 48)
            }

            // [Day 3, 2026-05-16] Local preview PiP — top-right, 96x160
            // rounded card. Only rendered for video calls and only once
            // the local camera publish has handed us a LocalVideoTrack.
            if hasVideo, let local = session.localVideoTrack {
                VStack {
                    HStack {
                        Spacer()
                        SwiftUIVideoView(local)
                            .frame(width: 96, height: 160)
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

    // MARK: - Helpers

    private func initialFor(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = trimmed.isEmpty ? callerEmail : trimmed
        guard let first = source.first else { return "?" }
        return String(first).uppercased()
    }

    // Shared circle-button factory. `enabled` controls only opacity for
    // now — the button is always tappable so the user can toggle back on.
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
