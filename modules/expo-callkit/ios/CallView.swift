// Stage #995 — full native SwiftUI UI, replaces JS /call.js on mobile + Stage #993 PiP wired
//
// CallView.swift — the 1:1 native SwiftUI call screen. Mirrors every visible
// element of app/call.js (the JS hybrid implementation) so a user moving from
// a JS build to a native build sees the exact same surface: large peer avatar
// (1:1) with double pulse-rings during ringing, full-bleed remote video once
// the LiveKit subscription comes in, a draggable local-preview PiP, the WhatsApp-
// style bottom action bar with circular buttons (mic, camera, speaker w/
// long-press audio picker, screen share, add member, hangup), and the top bar
// (minimize → AVPictureInPicture, switch camera, video toggle). Active-speaker
// breathing green ring, connection-quality bars, glassmorphism gradient and
// floating emoji bursts are all here.
//
// Architecture:
//   - `CallView` is the SwiftUI root.
//   - It binds to `CallSessionState` (declared in CallViewController.swift),
//     which the VC mutates as LiveKit reports state changes.
//   - User taps trigger closures (`onHangup`, `onToggleMute`, `onToggleCam`,
//     `onToggleSpeaker`, `onSwitchCamera`, `onScreenShare`, `onAddMember`,
//     `onMinimize`, `onSendReaction`). The VC owns the suspend / actor work
//     and rolls back optimistic UI flips on throw.
//   - Strings are hardcoded pt-BR (Stage #995 doesn't migrate i18n; that's a
//     follow-up: the JS shipping today is also pt-BR-only).
//   - SF Symbols only — no PNGs, no emoji-as-icon.
//   - iOS 15+ (matches the rest of the module).

import SwiftUI
import UIKit
import Combine
import LiveKitClient
import AVKit
// [WAVE 142 GPT-5.5-pro] Snippet 1 — explicit CallKit + AVFoundation imports
// so CallSessionObserver bindings + UINotificationFeedbackGenerator celebrate
// path resolve without leaning on AVKit's transitive AVFoundation export.
import CallKit
import AVFoundation

// MARK: - Floating reaction model

/// One floating emoji burst spawned by either side via the data channel. The
/// VC appends to `session.floatingReactions`; SwiftUI animates each up and
/// removes it from the array after ~3s via a fixed `.task` per emoji.
struct CallFloatingReaction: Identifiable, Equatable {
    let id: UUID
    let emoji: String
    let spawnedAt: Date
    /// Horizontal offset from screen center in points, picked at spawn time.
    let xOffset: CGFloat
}

// MARK: - WAVE 142 GPT-5.5-pro helpers (deterministic avatar palette + blur bg)

// [WAVE 142 GPT-5.5-pro] Snippet 4 — `Color(rgb:)` so the palette table reads
// like a CSS / Android counterpart (we already use the same hex codes in the
// Compose CallActivity). Keeps the AvatarPalette tuples short and inline.
private extension Color {
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 4 — deterministic avatar palette. Same FNV
// hash that the Compose / web versions use so the same caller picks the same
// gradient across platforms. Five WhatsApp-y palettes hand-picked to read
// well over the dark glassmorphism overlay.
private struct AvatarPalette {
    static let palettes: [[Color]] = [
        [Color(rgb: 0x0EA5E9), Color(rgb: 0x8B5CF6)],
        [Color(rgb: 0x22C55E), Color(rgb: 0x14B8A6)],
        [Color(rgb: 0xF97316), Color(rgb: 0xEC4899)],
        [Color(rgb: 0x6366F1), Color(rgb: 0x06B6D4)],
        [Color(rgb: 0x25D366), Color(rgb: 0x128C7E)]
    ]

    static func colors(for key: String) -> [Color] {
        var hash: UInt32 = 2166136261
        for b in key.lowercased().utf8 {
            hash ^= UInt32(b)
            hash = hash &* 16777619
        }
        return palettes[Int(hash % UInt32(palettes.count))]
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 4 — full-bleed avatar-blur background used by
// `backgroundLayer` while we wait for the remote VideoTrack first frame.
// Layers: deterministic gradient, scaled+blurred avatar bitmap (if any), a
// thin glass material, then a top→bottom black gradient so the avatar/status
// stay readable. Crossfades to/from the remote video via opacity in
// `backgroundLayer`.
private struct AvatarBlurBackground: View {
    let name: String
    let email: String
    let avatarUrl: String

    var key: String { email.isEmpty ? name : email }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: AvatarPalette.colors(for: key),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            if !avatarUrl.isEmpty, let url = URL(string: avatarUrl) {
                AsyncImage(url: url, transaction: Transaction(animation: .easeInOut(duration: 0.25))) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                            .scaleEffect(1.16)
                            .blur(radius: 44, opaque: true)
                            .opacity(0.78)
                    }
                }
            }

            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.18)

            LinearGradient(
                colors: [
                    .black.opacity(0.10),
                    .black.opacity(0.45),
                    .black.opacity(0.78)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 6 — three concentric pulse rings staggered
// by 0.34s. Rendered via TimelineView so we don't need three separate
// `withAnimation(.repeatForever)` blocks competing on the view's runloop.
// Auto-removed when `active == false`.
private struct ThreePulseRings: View {
    let active: Bool
    var baseSize: CGFloat = 182

    var body: some View {
        if active {
            // [WAVE 148 2026-05-22 LAYOUT-LOOP FIX — ROOT CAUSE]
            // Crash bug_type 309 watchdog 0x8BADF00D — Swift UI infinite layout
            // loop. Original WAVE 142 code used `.frame(width: baseSize * p)`
            // which makes the Circle's size fluctuate 142pt→258pt every frame.
            // ZStack parent (220×220) keeps re-negotiating size → recursion in
            // UnaryLayoutEngine.childPlacement → main thread stuck → iOS kills.
            //
            // Fix: fixed `.frame(baseSize, baseSize)` (does NOT change) +
            // `.scaleEffect(0.78 + 0.64 * p)` which is RENDER-only and does
            // NOT propagate to layout. Mirrors the working pattern in
            // `pulseRing` helper (line ~742).
            TimelineView(.animation) { context in
                ZStack {
                    ForEach(0..<3, id: \.self) { i in
                        let p = phase(time: context.date.timeIntervalSinceReferenceDate, index: i)
                        Circle()
                            .stroke(Color.white.opacity(Double(0.42 * (1 - p))), lineWidth: 2)
                            .frame(width: baseSize, height: baseSize)
                            .scaleEffect(0.78 + 0.64 * p)
                    }
                }
            }
            .frame(width: baseSize, height: baseSize)
            .allowsHitTesting(false)
        }
    }

    private func phase(time: TimeInterval, index: Int) -> CGFloat {
        let period: Double = 1.8
        let shifted = time - Double(index) * 0.34
        let mod = shifted - floor(shifted / period) * period
        return CGFloat(mod / period)
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 7 — animated `...` status dots, cycling
// every 0.42s. Used by `subtitleView` while the call is still ringing /
// connecting so the status looks alive without animating the whole label.
private struct AnimatedDotsText: View {
    let base: String
    let color: Color
    let font: Font

    // [WAVE 151 2026-05-22] ROOT CAUSE FIX for crash 0x8BADF00D on build 552.
    //
    // Apple crash report stack trace:
    //   _UIHostingView.beginTransaction → GraphHost.runTransaction →
    //   AG::Subgraph::update → SubscriptionView.Subscriber.updateValue →
    //   MutableBox.value.setter → Publishers.Autoconnect.deinit →
    //   Color full type metadata → _xzm_free
    //
    // Cause: Timer.publish().autoconnect() in @State + onReceive triggers a
    // SwiftUI render-loop runaway. Each .42s tick mutates `dots` state, which
    // invalidates the AttributeGraph node, which re-evaluates body, which
    // captures the publisher in a new child Subscriber, which causes the old
    // Autoconnect to deinit *inside* the active transaction. The transaction
    // doesn't close before the next tick fires; SpringBoard measures 5s hang
    // on main runloop and kills the process. The `.common` runloop mode
    // makes it worse because it includes animation tracking — exactly where
    // you cannot mutate state without reentrancy.
    //
    // Refs: FB8365664 (Apple Developer Forums 656873), thread 731676.
    //
    // Fix: TimelineView(.periodic) derives the dot count from `context.date`
    // directly — zero @State mutation, zero publisher lifecycle, zero feedback
    // loop. SwiftUI controls the schedule via display link; pauses in
    // background automatically. Runs outside the main GraphHost transaction.
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.42)) { context in
            let dots = Int(context.date.timeIntervalSince1970 / 0.42) % 4
            Text(base + String(repeating: ".", count: dots).padding(toLength: 3, withPad: " ", startingAt: 0))
                .font(font)
                .foregroundColor(color)
                .monospacedDigit()
        }
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 8 — 132pt avatar circle with deterministic
// gradient fill + initial letter + AsyncImage overlay. Replaces the inline
// stack inside `avatarBlock` so the new pulse rings + speaker glow can
// compose around it cleanly.
private struct PolishedAvatarCircle: View {
    let name: String
    let email: String
    let avatarUrl: String

    private var key: String { email.isEmpty ? name : email }
    private var initial: String {
        String((name.isEmpty ? email : name).trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: AvatarPalette.colors(for: key),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.5), radius: 16, x: 0, y: 8)

            Text(initial.isEmpty ? "?" : initial)
                .font(.system(size: 54, weight: .semibold, design: .rounded))
                .foregroundColor(.white)

            if !avatarUrl.isEmpty, let url = URL(string: avatarUrl) {
                AsyncImage(url: url, transaction: Transaction(animation: .easeIn(duration: 0.2))) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                            .clipShape(Circle())
                            .transition(.opacity)
                    }
                }
            }
        }
        .frame(width: 132, height: 132)
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 13 — pulsing green ring overlaid on the
// local PiP preview tile while the local user is the active speaker. Breathes
// at 3.2 Hz, modulated by `level` (0..1 — the LiveKit speaking metric).
private struct ActiveSpeakerGlowRing: View {
    let active: Bool
    let level: CGFloat

    var body: some View {
        if active {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                let breath = 0.65 + 0.35 * CGFloat(sin(t * 3.2) * 0.5 + 0.5)
                let alpha = min(1, 0.35 + level * 0.55) * breath

                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color(rgb: 0x25D366).opacity(alpha), lineWidth: 3)
                    .shadow(color: Color(rgb: 0x25D366).opacity(alpha), radius: 14)
            }
            .allowsHitTesting(false)
        }
    }
}

// [WAVE 142 GPT-5.5-pro] Snippet 14 — connect-celebration modifier. Plays a
// `.success` haptic and a 0.42/0.68 spring scale bounce the first time the
// status flips to "Conectado". Tracks `lastStatus` so re-renders from other
// state changes don't re-fire the celebration.
private struct ConnectedCelebrationModifier: ViewModifier {
    let status: String
    @State private var scale: CGFloat = 1
    @State private var lastStatus: String = ""

    func body(content: Content) -> some View {
        content
            .scaleEffect(scale)
            .onChange(of: status) { newValue in
                guard newValue == "Conectado", lastStatus != "Conectado" else {
                    lastStatus = newValue
                    return
                }
                lastStatus = newValue
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                scale = 0.9
                withAnimation(.spring(response: 0.42, dampingFraction: 0.68)) {
                    scale = 1
                }
            }
    }
}

// MARK: - Top-level call view

struct CallView: View {
    // Initial params passed from the hosting UIViewController. Immutable —
    // they describe the call we were launched with and never change for the
    // life of the view.
    let callId: String
    let callerName: String
    let callerEmail: String
    let hasVideo: Bool

    /// Source of truth. The VC owns the instance; SwiftUI re-renders on every
    /// `@Published` mutation. Declared in CallViewController.swift.
    @ObservedObject var session: CallSessionState

    // Closures wired by the VC. The VC owns LiveKit Room mutations, audio
    // session overrides, ReplayKit toggles, and PiP activation; SwiftUI just
    // forwards intent.
    let onHangup: () -> Void
    let onToggleMute: (Bool) -> Void
    let onToggleCam: (Bool) -> Void
    let onToggleSpeaker: (Bool) -> Void
    let onSwitchCamera: () -> Void
    let onScreenShare: () -> Void
    let onAddMember: () -> Void
    let onMinimize: () -> Void
    let onSendReaction: (String) -> Void
    /// [RNNoise, 2026-05-17] Flip the per-user noise-suppression toggle.
    let onToggleNoiseSuppression: (Bool) -> Void
    /// [MediaPipe, 2026-05-17] Cycle background-effect mode.
    let onCycleBackground: () -> Void
    /// [#1189 features, 2026-05-19] Toggle CallKit-backed call hold.
    /// The VC fires CXSetHeldCallAction so the system call bar + LK Room
    /// stay in sync; the boolean is the desired held state (true = hold).
    let onToggleHold: ((Bool) -> Void)?
    /// [DTMF, 2026-05-19] Forward a tapped digit to the module's playDTMF
    /// function. The VC publishes the digit over the LK data channel +
    /// plays the local feedback tone. Optional so existing call sites that
    /// haven't been migrated still compile.
    var onPlayDTMF: ((String) -> Void)? = nil
    /// [Wave C-1, 2026-05-21] Tap the chat icon while in-call to navigate
    /// to the associated chat thread. The VC emits `onOpenChat` to JS and
    /// then minimises the call to PiP so the conversation screen is visible.
    var onOpenChat: (() -> Void)? = nil

    // MARK: - Local UI state
    //
    // Anything that doesn't need to survive a VC bounce or be observed by the
    // VC lives here. Sheet visibility, picker selection, drag offset, etc.

    @State private var showAudioPicker: Bool = false
    @State private var showEmojiBar: Bool = false
    @State private var showMoreSheet: Bool = false
    /// [DTMF, 2026-05-19] When true, the 4×3 keypad overlay is presented
    /// above the action bar so the user can tap digits during a PSTN /
    /// IVR call. Dismisses on tap outside, on hangup, or on the close pill.
    @State private var showKeypad: Bool = false
    /// [DTMF, 2026-05-19] Live readback of digits the user tapped this
    /// keypad session. Cleared on dismiss. Shown as a "type" preview at
    /// the top of the overlay so the user sees their entry.
    @State private var dtmfBuffer: String = ""
    @State private var pipOffset: CGSize = CGSize(width: 0, height: 0)
    @State private var pipDragOffset: CGSize = CGSize(width: 0, height: 0)
    @State private var controlsVisible: Bool = true
    @State private var controlsHideTask: Task<Void, Never>? = nil
    @State private var pulseScale: CGFloat = 1.0
    @State private var pulseOpacity: Double = 0.6
    @State private var speakerPulse: CGFloat = 1.0
    @State private var elapsedSeconds: Int = 0
    @State private var timer: Timer? = nil
    /// [#1176 polish, 2026-05-18] Avatar URL side-channelled from
    /// ExpoCallKitModule.startOutgoingCall via the App Group UserDefaults
    /// key `callAvatar:<callId>`. CallViewController constructs CallView
    /// with fixed positional args so we can't extend the init without
    /// modifying the VC (which is forbidden by the in-flight worktree).
    /// `.onAppear` reads the URL and AsyncImage renders the photo on top
    /// of the initial-letter placeholder.
    @State private var avatarUrl: String = ""

    // [WAVE 142 GPT-5.5-pro] Snippet 3 — bind the shared CallSessionObserver
    // so we mirror CallKit-side signals (mute, status, duration) without
    // requiring a JS round trip. The VC's `session` remains source of truth
    // for LK Room state; this observer just makes the SwiftUI surface feel
    // instant when the user mutes from the system call bar.
    @ObservedObject private var callKit = CallSessionObserver.shared

    // Palette matches the JS /call.js + Android CallActivity. Pulled from the
    // WhatsApp dark-call screen — same hex values across iOS/Android so the
    // experience is consistent across platforms.
    private let backgroundColor = Color(red: 0x0B/255.0, green: 0x14/255.0, blue: 0x1A/255.0)
    private let chipColor       = Color(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0)
    private let hangupColor     = Color(red: 0xE5/255.0, green: 0x39/255.0, blue: 0x35/255.0)
    private let secondaryText   = Color(red: 0x86/255.0, green: 0x96/255.0, blue: 0xA0/255.0)
    private let speakerRingColor = Color(red: 0x2E/255.0, green: 0xCC/255.0, blue: 0x71/255.0)

    // MARK: - Body

    // [WAVE 153 2026-05-22] NUCLEAR FIX — CallView SwiftUI inteiro renderiza
    // EmptyView. Crash em build 552/553/554 todos no _UIHostingView.layoutSubviews
    // → DynamicBody.updateValue → metadata cache infinite loop. CallView (1795
    // linhas, ZStacks aninhados, GeometryReaders, Pulse rings, glassmorphism)
    // não converge no layout SwiftUI. WAVE 152 desabilitou só uma das 5 entradas
    // de criação de CallViewController; CXStartCallAction continuava criando.
    //
    // WAVE 153 mata pela raiz: body = EmptyView. CallViewController + UIHostingController
    // ainda são instanciados (pra não quebrar callsites) mas renderizam NADA.
    // Zero SwiftUI tree = zero layout loop = zero crash.
    //
    // Resultado: durante call, app não mostra a UI rica (apenas CallKit nativa).
    // Ligação FUNCIONA. Hangup FUNCIONA. Sem crash.
    //
    // TODO: reescrever CallView em UIKit puro (estilo Telegram, ~200 linhas)
    // pra ter UI bonita SEM SwiftUI layout-loop. Próxima sessão.
    var body: some View {
        Color.black.ignoresSafeArea()
    }

    private var _legacyBodyDisabled: some View {
        ZStack {
            // ── 1. Background (remote video when subscribed; gradient otherwise)
            backgroundLayer
                .ignoresSafeArea()

            // ── 2. Subtle glassmorphism overlay so the avatar / status text
            //      stay readable even when the remote feed is bright. Skipped
            //      when there's no video so the dark color shows through.
            // [WAVE 142 GPT-5.5-pro] Snippet 10 — gate on first-frame too.
            if !hasVideo || !session.remoteVideoFirstFrame {
                LinearGradient(
                    colors: [
                        Color.black.opacity(0.0),
                        Color.black.opacity(0.55)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            }

            // ── 3. Main content stack (avatar + name + status + controls)
            VStack(spacing: 0) {
                topBar
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .opacity(controlsVisible ? 1 : 0)
                    .animation(.easeInOut(duration: 0.25), value: controlsVisible)

                Spacer().frame(height: 24)

                // 1:1 layout: show avatar block when no remote video.
                // [WAVE 142 GPT-5.5-pro] Snippet 10 — gate on
                // `remoteVideoFirstFrame` (not just track presence) so the
                // crossfade ducks the avatar AFTER the first decoded frame
                // arrives. `.transition(.opacity + scale)` softens the swap.
                if !hasVideo || !session.remoteVideoFirstFrame {
                    avatarBlock
                        .transition(.opacity.combined(with: .scale(scale: 0.985)))
                        .animation(.easeInOut(duration: 0.30), value: session.remoteVideoFirstFrame)
                }

                Spacer()

                bottomActionBar
                    .padding(.horizontal, 16)
                    .padding(.bottom, 36)
                    .opacity(controlsVisible ? 1 : 0)
                    .animation(.easeInOut(duration: 0.25), value: controlsVisible)
            }

            // ── 4. Local preview PiP (draggable, top-right by default)
            if hasVideo, session.camEnabled, let local = session.localVideoTrack {
                localPreviewTile(local)
            }

            // ── 5. Floating emoji reactions
            ZStack {
                ForEach(session.floatingReactions) { reaction in
                    FloatingEmojiView(reaction: reaction)
                }
            }
            .allowsHitTesting(false)

            // ── 6. Quick-reactions emoji bar (slides up from bottom)
            if showEmojiBar {
                VStack {
                    Spacer()
                    emojiQuickBar
                        .padding(.bottom, 132)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // ── 7. More sheet overlay (raise hand, recording, hold)
            if showMoreSheet {
                moreSheetOverlay
                    .transition(.opacity)
            }

            // ── 8. [DTMF, 2026-05-19] Keypad overlay. Sits between the
            // background and the action bar so the user can still see the
            // hangup button (the overlay leaves the bottom of the action bar
            // exposed via padding). Tap outside the keypad card dismisses.
            if showKeypad {
                keypadOverlay
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .preferredColorScheme(.dark)
        .contentShape(Rectangle())
        .onTapGesture {
            // Single tap on the call body toggles control visibility — matches
            // the JS /call.js handleScreenTap behavior. Only applies once video
            // is up and the peer is connected; otherwise the controls stay
            // pinned so the user can hang up from the ringing state.
            if hasVideo && session.remoteVideoTrack != nil {
                toggleControls()
            }
        }
        .onAppear {
            startTimerIfNeeded()
            startPulseAnimation()
            startSpeakerPulseAnimation()
            scheduleControlsHide()
            // [#1176 polish, 2026-05-18] Pull the avatar URL stashed by
            // ExpoCallKitModule.startOutgoingCall (App Group UserDefaults
            // key `callAvatar:<callId>`). For the answer (incoming) path the
            // key isn't populated today — initial-letter stays the fallback.
            if let ud = UserDefaults(suiteName: "group.com.onemundo.mail"),
               let url = ud.string(forKey: "callAvatar:\(callId)"),
               !url.isEmpty {
                avatarUrl = url
            }
            // [WAVE 142 GPT-5.5-pro] Snippet 3 — bind the shared observer to
            // this call so its Published surface starts emitting status /
            // duration / mute signals from CallKit. Idempotent.
            callKit.attach(callId: callId, uuid: session.callUUID, hasVideo: hasVideo)
        }
        // [WAVE 142 GPT-5.5-pro] Snippet 3 — mirror observer state back into
        // the VC's session so the SwiftUI flags update without a JS round trip.
        // `removeDuplicates()` avoids redundant view diffs when the observer
        // republishes the same value (e.g. the per-second duration tick when
        // we're still on the same second integer).
        .onReceive(callKit.$statusText.removeDuplicates()) { value in
            if !value.isEmpty { session.status = value }
        }
        .onReceive(callKit.$isMuted.removeDuplicates()) { muted in
            session.micEnabled = !muted
        }
        .onReceive(callKit.$duration.removeDuplicates()) { seconds in
            elapsedSeconds = seconds
        }
        // [WAVE 142 GPT-5.5-pro] Snippet 14 — apply the spring/haptic
        // celebration whenever `session.status` flips to "Conectado".
        .modifier(ConnectedCelebrationModifier(status: session.status))
        .onDisappear {
            timer?.invalidate()
            timer = nil
            controlsHideTask?.cancel()
            // [#1176 polish, 2026-05-18] Clear the App Group avatar key for
            // this callId so consecutive calls don't leak URLs into a
            // dangling cache. The next outgoing call writes a fresh entry.
            UserDefaults(suiteName: "group.com.onemundo.mail")?
                .removeObject(forKey: "callAvatar:\(callId)")
        }
        // Re-run the auto-hide cycle whenever connection state flips — once
        // the call connects we want a hide-after-5s, but during ringing the
        // controls should stay glued.
        .onChange(of: session.status) { _ in
            scheduleControlsHide()
        }
        // Sheets are presented via `.sheet` so they get the native iOS feel
        // (drag-to-dismiss, blur backing) without us re-implementing them.
        .sheet(isPresented: $showAudioPicker) {
            Group {
                if #available(iOS 16.0, *) {
                    audioPickerSheet.presentationDetents([.height(280)])
                } else {
                    audioPickerSheet
                }
            }
        }
    }

    // MARK: - Background

    /// The full-bleed back layer. Three states:
    ///   1. Audio call OR video call awaiting first remote frame → dark grad.
    ///   2. Video call with remote VideoTrack → fullscreen SwiftUIVideoView.
    ///   3. Peer screen-sharing → screen-share track replaces camera feed.
    // [WAVE 142 GPT-5.5-pro] Snippet 5 — replace the old flat gradient with a
    // crossfaded stack: deterministic avatar-blur background underneath, the
    // remote LK video on top once `remoteVideoFirstFrame` flips. The flag is
    // intended to be set by the LK renderer first-frame callback (real path);
    // the .onAppear fallback below covers the case where the VC pushed the
    // track before wiring the callback so we never see a black flash.
    @ViewBuilder
    private var backgroundLayer: some View {
        ZStack {
            AvatarBlurBackground(
                name: callerName,
                email: callerEmail,
                avatarUrl: avatarUrl
            )
            .opacity(hasVideo && session.remoteVideoFirstFrame ? 0 : 1)

            if hasVideo, let remote = session.remoteVideoTrack {
                SwiftUIVideoView(remote)
                    .ignoresSafeArea()
                    .opacity(session.remoteVideoFirstFrame ? 1 : 0)
                    .animation(.easeInOut(duration: 0.32), value: session.remoteVideoFirstFrame)
                    .onAppear {
                        // Preferir setar isto pelo callback real do renderer/VC.
                        // Este fallback evita flash preto quando o track chega antes do frame.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                            if session.remoteVideoTrack != nil {
                                session.remoteVideoFirstFrame = true
                            }
                        }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.32), value: session.remoteVideoFirstFrame)
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            // Minimize → PiP. Tap fires onMinimize so the VC can call
            // pipController.startPictureInPicture() (Stage #993 wire in
            // CallViewController.setupPiPController).
            iconChip(systemName: "chevron.down", action: {
                hapticTap()
                onMinimize()
            })

            // Connection-quality bars — three vertical bars whose height +
            // opacity follow session.connectionQuality. WhatsApp shows this
            // in the top-leading area too.
            ConnectionQualityBars(quality: session.connectionQuality)
                .frame(width: 22, height: 22)

            // [Wave C-1, 2026-05-21] Back-to-chat button. Tapping it fires
            // onOpenChat (VC emits `onOpenChat` event to JS → JS pushes the
            // /chat-conversation screen) and minimises the call to PiP so
            // the chat thread is visible. Only shown while the call is active
            // (not while ringing) so callers can't accidentally skip to chat
            // before a call even connects. WhatsApp shows an identical icon
            // in the same position (between quality bars and Spacer).
            if session.status == "Conectado" || session.status.hasPrefix("Conectad") {
                iconChip(systemName: "bubble.left.fill", action: {
                    hapticTap()
                    onOpenChat?()
                })
            }

            Spacer()

            // Switch front/back camera. Only meaningful for video calls; we
            // hide it entirely for audio so the bar isn't visually cluttered.
            if hasVideo && session.camEnabled {
                iconChip(systemName: "camera.rotate.fill", action: {
                    hapticTap()
                    onSwitchCamera()
                })
            }

            // Top-right "video toggle" — same as the bottom bar's video button
            // but ergonomically reachable when in a video call (matches Meet/
            // WhatsApp redundancy). Mirrors `videoEnabled` in JS /call.js.
            if hasVideo {
                iconChip(systemName: session.camEnabled ? "video.fill" : "video.slash.fill", action: {
                    let desired = !session.camEnabled
                    session.camEnabled = desired
                    hapticTap()
                    onToggleCam(desired)
                })
            }
        }
    }

    /// Small circular chip used in the top bar. 36×36 SF Symbol over a faded
    /// black background — lets the icon read clearly over both the dark grad
    /// and over the remote video.
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

    // MARK: - Avatar block (1:1 audio / pre-remote video)

    // [WAVE 142 GPT-5.5-pro] Snippet 9 — replace the inline avatar stack with
    // the polished helpers: ThreePulseRings (white, staggered) + speaker glow
    // (green, modulated by `speakerPulse`) + PolishedAvatarCircle (132pt
    // gradient w/ shadow). Name uses 28pt semibold rounded for visual weight
    // parity with WhatsApp 2025 / iOS Phone. Status switches between the
    // dotted "Chamando..." and the formatted duration once connected.
    private var avatarBlock: some View {
        VStack(spacing: 16) {
            ZStack {
                ThreePulseRings(active: session.status != "Conectado")

                if session.remoteIsActiveSpeaker {
                    // [WAVE 148] same layout-loop fix — fixed frame + scaleEffect.
                    Circle()
                        .stroke(Color(rgb: 0x25D366).opacity(0.82), lineWidth: 4)
                        .frame(width: 154, height: 154)
                        .scaleEffect(speakerPulse)
                        .shadow(color: Color(rgb: 0x25D366).opacity(0.7), radius: 14)
                }

                PolishedAvatarCircle(
                    name: callerName,
                    email: callerEmail,
                    avatarUrl: avatarUrl
                )
            }
            .frame(width: 220, height: 220)

            Text(callerName.isEmpty ? callerEmail : callerName)
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.82)

            subtitleView
        }
    }

    // [WAVE 142 GPT-5.5-pro] Snippet 9 — subtitle: monospaced timer when
    // connected, animated dotted base otherwise. Transitions via opacity so
    // the swap feels smooth instead of cutting.
    @ViewBuilder
    private var subtitleView: some View {
        if session.status == "Conectado" {
            Text(formatDuration(elapsedSeconds))
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(secondaryText)
                .monospacedDigit()
                .transition(.opacity)
        } else {
            AnimatedDotsText(
                base: session.status
                    .replacingOccurrences(of: "\u{2026}", with: "")
                    .replacingOccurrences(of: "...", with: ""),
                color: secondaryText,
                font: .system(size: 16, weight: .medium)
            )
            .transition(.opacity)
        }
    }

    /// One pulse ring. SwiftUI redraws via `pulseScale` + `pulseOpacity` —
    /// driven from `.onAppear`'s repeating animation in this view.
    private func pulseRing(scale: CGFloat, opacity: Double) -> some View {
        Circle()
            .stroke(Color.white.opacity(opacity), lineWidth: 2)
            .frame(width: 168, height: 168)
            .scaleEffect(scale)
    }

    // MARK: - Local preview PiP

    /// Draggable local-camera tile. 100×140, rounded-12, top-right by default.
    /// Snaps to the nearest screen edge on release (mirrors the JS PanResponder
    /// behavior in /call.js).
    @ViewBuilder
    private func localPreviewTile(_ track: LocalVideoTrack) -> some View {
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
                // [WAVE 142 GPT-5.5-pro] Snippet 13 — active-speaker glow ring
                // over the local PiP tile. Driven by `session.localIsActiveSpeaker`
                // + `session.localSpeakerLevel`, set by the VC's LK audio-level
                // delegate (snippet 2 added the @Published flags).
                .overlay {
                    ActiveSpeakerGlowRing(
                        active: session.localIsActiveSpeaker,
                        level: session.localSpeakerLevel
                    )
                }
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
                        .onChanged { value in
                            pipDragOffset = value.translation
                        }
                        .onEnded { value in
                            // Snap to nearest edge horizontally; clamp Y to the
                            // visible safe area minus the bottom bar so the
                            // tile never gets stuck under the controls.
                            let predictedX = proxy.size.width - baseWidth / 2 - 16
                                + pipOffset.width + value.translation.width
                            let snapToRight = predictedX > proxy.size.width / 2
                            let targetX: CGFloat = snapToRight
                                ? 0
                                : -(proxy.size.width - baseWidth - 32)
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
            // Top row: secondary actions (screen share, add member, more,
            // react, RNNoise, background blur). Two rows when needed — the
            // HStack wraps via ScrollView so 6+ pills don't crowd a small
            // screen.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 16) {
                    actionPillButton(
                        icon: "rectangle.on.rectangle",
                        label: "Compartilhar",
                        enabled: session.remoteVideoTrack != nil || session.status == "Conectado",
                        action: { hapticTap(); onScreenShare() }
                    )

                    actionPillButton(
                        icon: "person.badge.plus",
                        label: "Adicionar",
                        enabled: true,
                        action: { hapticTap(); onAddMember() }
                    )

                    // [DTMF, 2026-05-19] Keypad — opens the 4×3 DTMF
                    // overlay. Visible during any connected call (audio or
                    // video) so PSTN/IVR scenarios work.
                    actionPillButton(
                        icon: "circle.grid.3x3.fill",
                        label: "Teclado",
                        enabled: true,
                        active: showKeypad,
                        action: {
                            hapticTap()
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showKeypad.toggle()
                                if !showKeypad { dtmfBuffer = "" }
                            }
                        }
                    )

                    // [RNNoise, 2026-05-17] Cancelar ruído — flips the
                    // per-user ML noise-suppression toggle. Default ON.
                    actionPillButton(
                        icon: session.noiseSuppression ? "waveform.path.ecg" : "waveform.slash",
                        label: "Sem ruído",
                        enabled: true,
                        active: session.noiseSuppression,
                        action: {
                            hapticTap()
                            onToggleNoiseSuppression(!session.noiseSuppression)
                        }
                    )

                    // [MediaPipe, 2026-05-17] Desfocar — cycles through
                    // blur / image background effects. Hidden when the call
                    // is audio-only (no camera frame to process).
                    if hasVideo {
                        actionPillButton(
                            icon: backgroundIconSymbol(session.backgroundMode),
                            label: backgroundLabel(session.backgroundMode),
                            enabled: true,
                            active: session.backgroundMode != "off",
                            action: {
                                hapticTap()
                                onCycleBackground()
                            }
                        )
                    }

                    actionPillButton(
                        icon: "ellipsis",
                        label: "Mais",
                        enabled: true,
                        action: {
                            hapticTap()
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showMoreSheet.toggle()
                            }
                        }
                    )

                    actionPillButton(
                        icon: "face.smiling",
                        label: "Reagir",
                        enabled: true,
                        action: {
                            hapticTap()
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                showEmojiBar.toggle()
                            }
                        }
                    )
                }
                .padding(.horizontal, 4)
            }

            // Primary row: mute, camera (video calls), speaker, hangup
            HStack(spacing: 24) {
                circleButton(
                    size: 64,
                    background: session.micEnabled ? chipColor : Color.white,
                    foreground: session.micEnabled ? .white : .black,
                    systemName: session.micEnabled ? "mic.fill" : "mic.slash.fill",
                    action: {
                        let desired = !session.micEnabled
                        session.micEnabled = desired
                        hapticTap()
                        onToggleMute(desired)
                    }
                )

                if hasVideo {
                    circleButton(
                        size: 64,
                        background: session.camEnabled ? chipColor : Color.white,
                        foreground: session.camEnabled ? .white : .black,
                        systemName: session.camEnabled ? "video.fill" : "video.slash.fill",
                        action: {
                            let desired = !session.camEnabled
                            session.camEnabled = desired
                            hapticTap()
                            onToggleCam(desired)
                        }
                    )
                }

                // Speaker button: tap toggles, long-press opens the audio
                // picker (Bluetooth / earpiece / speaker / wired). Mirrors the
                // /call.js openAudioPicker UX.
                circleButton(
                    size: 64,
                    background: session.speakerOn ? Color.white : chipColor,
                    foreground: session.speakerOn ? .black : .white,
                    systemName: session.speakerOn ? "speaker.wave.3.fill" : "speaker.fill",
                    action: {
                        let desired = !session.speakerOn
                        session.speakerOn = desired
                        hapticTap()
                        onToggleSpeaker(desired)
                    },
                    onLongPress: {
                        hapticTap()
                        showAudioPicker = true
                    }
                )

                circleButton(
                    size: 72,
                    background: hangupColor,
                    foreground: .white,
                    systemName: "phone.down.fill",
                    action: {
                        hapticHeavy()
                        onHangup()
                    }
                )

                // Hand raise (group only — for 1:1 we hide it; the same view
                // is used by GroupCallView with `isGroup=true`).
                if session.isGroup {
                    circleButton(
                        size: 56,
                        background: session.handRaised ? Color.yellow : chipColor,
                        foreground: session.handRaised ? .black : .white,
                        systemName: "hand.raised.fill",
                        action: {
                            session.handRaised.toggle()
                            hapticTap()
                            onSendReaction(session.handRaised ? "🖐️" : "")
                        }
                    )
                }
            }
        }
    }

    // MARK: - Buttons

    /// Pill button used for secondary actions (Screen share, Add member, More).
    /// Each is a 60×64 capsule with icon over label, dimmed when disabled.
    /// When `active` is true (e.g. noise suppression ON, background blur ON)
    /// the pill renders with a green tint so users can see the toggle state
    /// without opening a menu.
    // [WAVE 142 GPT-5.5-pro] Snippet 12 — glassmorphism capsule: stacked
    // `.ultraThinMaterial` + chipColor/white tint + hairline border. Active
    // state lightens the tint to 0.28 white so the user sees the toggle
    // without staring at the icon color alone.
    @ViewBuilder
    private func actionPillButton(
        icon: String,
        label: String,
        enabled: Bool,
        active: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    Capsule().fill(.ultraThinMaterial)
                    Capsule().fill((active ? Color.white : chipColor).opacity(active ? 0.28 : 0.42))
                    Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 1)

                    Image(systemName: icon)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.white)
                }
                .frame(width: 58, height: 42)

                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white.opacity(enabled ? 0.92 : 0.35))
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }

    // [MediaPipe, 2026-05-17] Helpers for the background pill label + icon.
    private func backgroundLabel(_ mode: String) -> String {
        switch mode {
        case "blur_low": return "Leve"
        case "blur_medium", "blur": return "Desfocar"
        case "blur_high": return "Forte"
        case "image": return "Fundo"
        default: return "Fundo"
        }
    }

    private func backgroundIconSymbol(_ mode: String) -> String {
        switch mode {
        case "image": return "photo.fill"
        case "off": return "circle.dashed"
        default: return "circle.dotted"
        }
    }

    /// Generic circular control button. Used for mic, cam, speaker, hangup,
    /// hand raise. Supports an optional long-press handler (speaker uses it).
    // [WAVE 142 GPT-5.5-pro] Snippet 11 — glassmorphism styling: stack a
    // `.ultraThinMaterial` blur + the tint at 62% opacity + a hairline white
    // border + the SF Symbol. Shadow at 28%/16pt grounds the button on top of
    // the avatar-blur background. `onLongPress` is preserved so the speaker
    // button can still open the AVRoutePicker sheet.
    @ViewBuilder
    private func circleButton(
        size: CGFloat,
        background: Color,
        foreground: Color,
        systemName: String,
        action: @escaping () -> Void,
        onLongPress: (() -> Void)? = nil
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)

                Circle()
                    .fill(background.opacity(0.62))

                Circle()
                    .strokeBorder(Color.white.opacity(0.24), lineWidth: 1)

                Image(systemName: systemName)
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundColor(foreground)
            }
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.28), radius: 16, x: 0, y: 8)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in onLongPress?() }
        )
    }

    // MARK: - Quick emoji bar

    // [reaction bar, 2026-05-17] Trimmed from 6 → 5 (dropped 🔥) so the bar
    // matches the cross-platform spec (Android `QuickEmojis`, iOS Group
    // `quickEmojis`, JS /call.js `CALL_EMOJIS` UI bar). 5 is the WhatsApp
    // 2025 baseline and keeps each tap target wider on phones.
    private let quickEmojis = ["❤️", "👍", "👏", "😂", "🎉"]

    private var emojiQuickBar: some View {
        HStack(spacing: 12) {
            ForEach(quickEmojis, id: \.self) { emoji in
                Button(action: {
                    hapticTap()
                    onSendReaction(emoji)
                    withAnimation(.easeOut(duration: 0.2)) {
                        showEmojiBar = false
                    }
                }) {
                    Text(emoji)
                        .font(.system(size: 30))
                        .frame(width: 48, height: 48)
                        .background(
                            Circle().fill(Color.white.opacity(0.12))
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            Capsule().fill(Color.black.opacity(0.55))
        )
    }

    // MARK: - More sheet (raise hand / recording / hold)

    private var moreSheetOverlay: some View {
        ZStack {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showMoreSheet = false
                    }
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

                    moreRow(icon: "hand.raised.fill", title: session.handRaised ? "Abaixar mão" : "Levantar mão") {
                        session.handRaised.toggle()
                        onSendReaction(session.handRaised ? "🖐️" : "")
                        withAnimation(.easeInOut(duration: 0.2)) { showMoreSheet = false }
                    }
                    // [#1189 features, 2026-05-19] Hold now wires through to
                    // CallKit (CXSetHeldCallAction) via the VC; the LK Room
                    // mutes both directions and the system call bar reflects
                    // the held state. Recording was previously a cosmetic
                    // toggle (state only, never actually recorded) — removed
                    // until the LK egress / AVAudioRecorder pipeline lands so
                    // we don't mislead users into thinking the call is saved.
                    moreRow(icon: session.onHold ? "play.fill" : "pause.fill", title: session.onHold ? "Retomar" : "Colocar em espera") {
                        let next = !session.onHold
                        onToggleHold?(next)
                        // Optimistic local flip; the VC's CXSetHeldCallAction
                        // completion will overwrite if the system rejects.
                        session.onHold = next
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

    // [Audio output picker, 2026-05-19] WhatsApp/Phone-grade real picker.
    // The fake speaker-only toggle previously here couldn't expose AirPods,
    // car Bluetooth, or wired headsets — users had to leave the app to
    // switch route. AVRoutePickerView is the system-blessed picker that
    // lists every connected output device + the call audio (earpiece +
    // speaker) options. We embed it as a hidden trigger (a UIView with size
    // 1×1 placed off-screen) and call `.routePickerButtonTapped`-equivalent
    // by sending the underlying button a touchUpInside on first appear, so
    // the sheet doesn't show two pickers stacked. The wrapper is also
    // visible inline as a normal labelled row so users can re-trigger it.
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

            // Quick toggles for the two routes AVRoutePickerView won't
            // surface (earpiece via override + loudspeaker). BT/wired/AirPlay
            // are listed automatically by the system picker triggered below.
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

                // Real system picker entry — opens the iOS-native list of
                // every available output (AirPods, car BT, USB-C headphones,
                // AirPlay receivers, …). Wrapped via UIViewRepresentable so
                // SwiftUI can host the UIKit AVRoutePickerView. Tapping the
                // row sends a touch to the embedded picker (which is sized
                // to fill the row), so the system sheet appears.
                AVRoutePickerRow()
                    .frame(height: 48)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 0)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.white.opacity(0.04))
                    )
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

    // MARK: - DTMF keypad overlay
    //
    // [DTMF, 2026-05-19] WhatsApp/Phone-style 4×3 grid. Each cell renders the
    // digit + its letter group (e.g. "2 ABC"), fires a haptic, and forwards
    // through `onPlayDTMF` which the VC routes into:
    //   - AudioServicesPlaySystemSound (the iOS DTMF beep family) for local
    //     audible feedback so the user knows their tap registered.
    //   - room.localParticipant.publish(data:) with payload
    //     `D:5` → peer can render the keypress in real time and a SIP/PSTN
    //     bridge converts to RFC 2833 in-band tones for IVRs.
    private let dtmfDigits: [[(digit: String, letters: String)]] = [
        [("1", " "), ("2", "ABC"), ("3", "DEF")],
        [("4", "GHI"), ("5", "JKL"), ("6", "MNO")],
        [("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ")],
        [("*", ""), ("0", "+"), ("#", "")],
    ]

    private var keypadOverlay: some View {
        ZStack {
            // Tap-outside dismiss layer. Half-opaque black so the underlying
            // call surface still reads.
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showKeypad = false
                        dtmfBuffer = ""
                    }
                }

            VStack {
                Spacer()
                VStack(spacing: 16) {
                    // Drag handle + tapped-digit readback
                    Capsule()
                        .fill(Color.white.opacity(0.3))
                        .frame(width: 40, height: 4)
                        .padding(.top, 10)

                    Text(dtmfBuffer.isEmpty ? "Teclado" : dtmfBuffer)
                        .font(.system(size: dtmfBuffer.isEmpty ? 17 : 26, weight: .medium, design: .rounded))
                        .foregroundColor(.white)
                        .padding(.bottom, 4)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)

                    VStack(spacing: 12) {
                        ForEach(0..<dtmfDigits.count, id: \.self) { rowIdx in
                            HStack(spacing: 22) {
                                ForEach(0..<dtmfDigits[rowIdx].count, id: \.self) { colIdx in
                                    let cell = dtmfDigits[rowIdx][colIdx]
                                    dtmfButton(digit: cell.digit, letters: cell.letters)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)

                    // Close pill — explicit dismissal so users who don't
                    // discover the tap-outside gesture still have a way out.
                    Button(action: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showKeypad = false
                            dtmfBuffer = ""
                        }
                    }) {
                        Text("Fechar")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.white)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 10)
                            .background(
                                Capsule().fill(Color.white.opacity(0.12))
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 24)
                }
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 24)
                        .fill(Color(red: 0x14/255.0, green: 0x1F/255.0, blue: 0x27/255.0))
                )
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
        }
    }

    /// One key on the DTMF pad. 68pt circle, digit + letter group below.
    @ViewBuilder
    private func dtmfButton(digit: String, letters: String) -> some View {
        Button(action: {
            hapticTap()
            dtmfBuffer = String((dtmfBuffer + digit).suffix(24)) // cap to avoid horizontal overflow
            onPlayDTMF?(digit)
        }) {
            VStack(spacing: 2) {
                Text(digit)
                    .font(.system(size: 30, weight: .regular, design: .rounded))
                    .foregroundColor(.white)
                if !letters.isEmpty {
                    Text(letters)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white.opacity(0.55))
                        .tracking(1)
                } else {
                    Spacer().frame(height: 12)
                }
            }
            .frame(width: 68, height: 68)
            .background(
                Circle().fill(Color.white.opacity(0.08))
            )
            .overlay(
                Circle().stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Animations & helpers

    private func startPulseAnimation() {
        withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) {
            pulseScale = 1.4
            pulseOpacity = 0
        }
    }

    private func startSpeakerPulseAnimation() {
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            speakerPulse = 1.12
        }
    }

    private func startTimerIfNeeded() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            guard session.status == "Conectado" else { return }
            elapsedSeconds += 1
        }
    }

    private func toggleControls() {
        withAnimation(.easeInOut(duration: 0.25)) {
            controlsVisible.toggle()
        }
        if controlsVisible {
            scheduleControlsHide()
        }
    }

    private func scheduleControlsHide() {
        controlsHideTask?.cancel()
        guard hasVideo, session.remoteVideoTrack != nil else { return }
        controlsHideTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if !Task.isCancelled {
                await MainActor.run {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        controlsVisible = false
                    }
                }
            }
        }
    }

    private func initialFor(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = trimmed.isEmpty ? callerEmail : trimmed
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

// MARK: - Connection-quality bars

/// Three vertical bars whose filled count + opacity track LiveKit's
/// `ConnectionQuality` enum, surfaced via `session.connectionQuality` as a
/// 0-3 score.
struct ConnectionQualityBars: View {
    let quality: Int

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<3) { i in
                let active = i < quality
                Capsule()
                    .fill(active ? barColor : Color.white.opacity(0.25))
                    .frame(width: 4, height: CGFloat(8 + i * 4))
            }
        }
    }

    private var barColor: Color {
        switch quality {
        case 3: return Color(red: 0x2E/255.0, green: 0xCC/255.0, blue: 0x71/255.0) // green
        case 2: return Color(red: 0xF1/255.0, green: 0xC4/255.0, blue: 0x0F/255.0) // amber
        default: return Color(red: 0xE7/255.0, green: 0x4C/255.0, blue: 0x3C/255.0) // red
        }
    }
}

// MARK: - Floating emoji

/// [reactions polish, 2026-05-17] One floating emoji bubble. Rises from the
/// bottom-center upward with a sinusoidal horizontal sway and fades after
/// 2 s. Lives independent of the session so animation timing is isolated;
/// the parent just appends to the array and removes it on a .task at ~3 s.
///
/// Why two animations instead of one: SwiftUI's `withAnimation(.easeOut)`
/// would tie both rise and opacity to the same curve, so the emoji starts
/// fading immediately. We want a 1-second clear hold + 1-second fade so the
/// user can identify the emoji before it dissolves — the way WhatsApp /
/// Messenger reactions feel. Sway uses a TimelineView to follow a sine wave
/// without needing repeating animation tokens.
struct FloatingEmojiView: View {
    let reaction: CallFloatingReaction
    @State private var rise: CGFloat = 0
    @State private var fadeOpacity: Double = 0
    @State private var swayPhase: Double = 0

    var body: some View {
        TimelineView(.animation) { timeline in
            // Phase 0..1 over 2.0 seconds. Two full sine periods produce a
            // visible sway without making the emoji feel like it's flailing.
            let elapsed = max(0, timeline.date.timeIntervalSince(reaction.spawnedAt))
            let phase = min(1.0, elapsed / 2.0)
            let swayPx = CGFloat(sin(phase * .pi * 4)) * 14
            Text(reaction.emoji)
                .font(.system(size: 44))
                .offset(x: reaction.xOffset + swayPx, y: -rise)
                .opacity(fadeOpacity)
        }
        .onAppear {
            // Rise: 380 pt over 2 s. Slightly more than before so the emoji
            // clearly leaves the bottom action area.
            withAnimation(.easeOut(duration: 2.0)) {
                rise = 380
            }
            // Pop in (200 ms) then 1 s hold then 1 s fade. Three discrete
            // segments give the bubble its WhatsApp "punch" feel.
            withAnimation(.easeIn(duration: 0.2)) {
                fadeOpacity = 1
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 1.0)) {
                    fadeOpacity = 0
                }
            }
        }
    }
}

// MARK: - AVRoutePickerView wrapper

/// [Audio output picker, 2026-05-19] SwiftUI bridge to the system
/// AVRoutePickerView. Lists every available output (built-in speaker /
/// earpiece via override, AirPods, BT headphones, AirPlay receivers, USB-C /
/// Lightning headsets, CarPlay) and switches the active route on tap.
/// We color the icon white over the dark sheet background.
struct AVRoutePickerRow: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        // Build a horizontal stack: icon (system picker) on the left + label
        // on the right. AVRoutePickerView is the actual tap target (it
        // expands its hit area to the entire bounds) so the user can tap
        // anywhere on the row.
        let container = UIView()
        container.backgroundColor = .clear

        let pickerView = AVRoutePickerView()
        pickerView.translatesAutoresizingMaskIntoConstraints = false
        pickerView.activeTintColor = UIColor(red: 0x2E/255.0, green: 0xCC/255.0, blue: 0x71/255.0, alpha: 1.0)
        pickerView.tintColor = .white
        pickerView.prioritizesVideoDevices = false
        container.addSubview(pickerView)

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Mais dispositivos…"
        label.textColor = .white
        label.font = .systemFont(ofSize: 16)
        container.addSubview(label)

        NSLayoutConstraint.activate([
            pickerView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            pickerView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            pickerView.widthAnchor.constraint(equalToConstant: 28),
            pickerView.heightAnchor.constraint(equalToConstant: 28),

            label.leadingAnchor.constraint(equalTo: pickerView.trailingAnchor, constant: 12),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
        ])

        // Forward taps on the whole row to the embedded picker button.
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.rowTapped))
        container.addGestureRecognizer(tap)
        context.coordinator.pickerView = pickerView
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        weak var pickerView: AVRoutePickerView?
        @objc func rowTapped() {
            // Walk the subview tree to find the underlying UIButton that
            // AVRoutePickerView wraps; sending touchUpInside opens the
            // native picker sheet. iOS doesn't expose a public method to
            // open it programmatically, so this is the standard trick used
            // by SwiftUI bridges across the community.
            guard let pickerView = pickerView else { return }
            for sub in pickerView.subviews {
                if let btn = sub as? UIButton {
                    btn.sendActions(for: .touchUpInside)
                    return
                }
            }
        }
    }
}

// MARK: - OngoingCallBar overlay (audio-only minimize path)
//
// [Wave WhatsApp parity, 2026-05-20 gap G4 iOS] When the user minimises a
// 1:1 audio call (no PiP — PiP only mounts for video), we drop a floating
// WhatsApp-green bar on top of the key window with the caller name + live
// timer + tap-to-restore. Mounted via a separate UIWindow at level
// `statusBar + 1` so it sits above every JS/SwiftUI surface, including
// modals presented by the chat list. Removed when handleHangup runs or the
// user taps it.
//
// We intentionally do NOT route this through the JS `OngoingCallBar.js`
// component because the audio-only minimize path leaves the JS render
// thread waiting on the SwiftUI host VC dismiss — the JS bar wouldn't
// repaint until the dismiss settled, and the user perceives a 200-500ms
// gap where nothing is visible.

struct OngoingCallBarOverlay: View {
    let callerName: String
    let hasVideo: Bool
    let startedAt: Date
    let onTap: () -> Void

    @State private var elapsed: Int = 0
    @State private var timer: Timer? = nil

    /// WhatsApp green for the audio-only bar; matches OngoingCallBar.js
    private let barColor = Color(red: 0x12/255.0, green: 0xB7/255.0, blue: 0x6A/255.0)

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Pulsing dot — visual cue the call is live.
                Circle()
                    .fill(Color.white)
                    .frame(width: 8, height: 8)
                    .opacity(elapsed % 2 == 0 ? 1.0 : 0.5)

                VStack(alignment: .leading, spacing: 2) {
                    Text(callerName)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Text(Self.formatElapsed(elapsed))
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.85))
                        .monospacedDigit()
                }

                Spacer(minLength: 8)

                Text("Toque para voltar")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(barColor)
        }
        .buttonStyle(.plain)
        .onAppear {
            elapsed = max(0, Int(Date().timeIntervalSince(startedAt)))
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
                elapsed = max(0, Int(Date().timeIntervalSince(startedAt)))
            }
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }

    private static func formatElapsed(_ s: Int) -> String {
        let m = s / 60
        let r = s % 60
        return String(format: "%02d:%02d", m, r)
    }
}

/// Holds a dedicated UIWindow that hosts `OngoingCallBarOverlay` above all
/// other content (including modals). Install/uninstall is idempotent so the
/// minimize button is safe to spam-tap.
@objc final class OngoingCallBarOverlayController: NSObject {
    @objc static let shared = OngoingCallBarOverlayController()

    private var window: UIWindow?
    private var hosting: UIViewController?

    func install(callerName: String,
                 hasVideo: Bool,
                 startedAt: Date,
                 onTapRestore: @escaping () -> Void) {
        if window != nil {
            // Already installed — replace the view so a new call replaces
            // the previous bar's caller name + timer.
            uninstall()
        }
        // Pick the active scene so this works in multitasking (iPad).
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }

        let win = UIWindow(windowScene: scene)
        win.windowLevel = UIWindow.Level.statusBar + 1
        win.backgroundColor = .clear
        win.isHidden = false

        let view = OngoingCallBarOverlay(
            callerName: callerName,
            hasVideo: hasVideo,
            startedAt: startedAt,
            onTap: { [weak self] in
                self?.uninstall()
                onTapRestore()
            }
        )
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .clear
        // Place the bar just below the status bar / Dynamic Island.
        let safeTop = scene.statusBarManager?.statusBarFrame.height ?? 44
        host.view.frame = CGRect(x: 0, y: safeTop, width: win.bounds.width, height: 48)
        host.view.autoresizingMask = [.flexibleWidth]
        let container = UIViewController()
        container.view.backgroundColor = .clear
        container.view.addSubview(host.view)
        container.addChild(host)
        host.didMove(toParent: container)
        win.rootViewController = container
        self.window = win
        self.hosting = container
        print("[OngoingCallBar] installed for caller=\(callerName) hasVideo=\(hasVideo)")
    }

    func uninstall() {
        guard let win = window else { return }
        win.isHidden = true
        window = nil
        hosting = nil
        print("[OngoingCallBar] uninstalled")
    }
}
