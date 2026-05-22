// [WAVE 142 GPT-5.5-pro] CallSessionObserver — lightweight ObservableObject
// surface bound from CallView.swift (`@ObservedObject callKit`). Mirrors the
// shape described in Part 3 of /root/webmail-app/.claude/codex_ui_build_plan.md
// but stays a minimal stub: it tracks the active CallKit UUID, mirrors the
// system-mute / end-call signals into Published properties, and updates a
// per-second duration timer. The existing CallViewController.swift already
// owns the LK Room, AVAudioSession, and the source-of-truth CallSessionState
// — this helper exists purely so the snippets compile and so future provider
// callbacks can flip status/duration without round-tripping through the VC.
//
// Why a separate file: snippet 3 expects `CallSessionObserver.shared` reachable
// from CallView; snippet 15 expects the same shared instance reachable from
// the CXProvider delegate inside ExpoCallKitModule.swift. Keeping the helper
// in its own file avoids touching the VC (which the in-flight worktree pins)
// and avoids re-declaring it inside the provider extension.

import Foundation
import Combine
import CallKit
import UIKit

/// Phase of the active native call. Mirrors `session.status` semantics in
/// CallView but with a strongly-typed enum so future code (analytics, watch
/// app, etc) can switch on it without string comparisons.
enum NativeCallPhase: String {
    case ringing, connecting, active, ended

    /// pt-BR rendering used by the SwiftUI `subtitleView`.
    var ptBR: String {
        switch self {
        case .ringing: return "Chamando\u{2026}"
        case .connecting: return "Conectando\u{2026}"
        case .active: return "Conectado"
        case .ended: return "Encerrada"
        }
    }
}

final class CallSessionObserver: NSObject, ObservableObject {
    static let shared = CallSessionObserver()

    @Published private(set) var phase: NativeCallPhase = .ringing
    @Published private(set) var statusText: String = ""
    @Published private(set) var isMuted: Bool = false
    @Published private(set) var isOnHold: Bool = false
    @Published private(set) var hasVideo: Bool = false
    @Published private(set) var duration: Int = 0

    private var activeCallUUID: UUID? = nil
    private var activeCallId: String? = nil
    private var startedAt: Date? = nil
    private var tickTimer: Timer? = nil

    private override init() {
        super.init()
    }

    /// Bind to a call. The SwiftUI CallView calls this in `.onAppear` so
    /// `statusText` / `duration` start flowing as soon as the screen mounts.
    /// Idempotent on re-attach (e.g. PiP → fullscreen restore).
    func attach(callId: String, uuid: UUID?, hasVideo: Bool) {
        DispatchQueue.main.async {
            self.activeCallId = callId
            self.activeCallUUID = uuid
            self.hasVideo = hasVideo
            // Don't reset statusText here — VC's own status may already be set.
            self.tickTimer?.invalidate()
            self.tickTimer = Timer.scheduledTimer(withTimeInterval: 1.0,
                                                  repeats: true) { [weak self] _ in
                guard let self = self else { return }
                guard let started = self.startedAt else { return }
                self.duration = max(0, Int(Date().timeIntervalSince(started)))
            }
        }
    }

    /// CallKit answered / connected — start the duration clock.
    func markConnected() {
        DispatchQueue.main.async {
            self.phase = .active
            self.statusText = NativeCallPhase.active.ptBR
            if self.startedAt == nil { self.startedAt = Date() }
        }
    }

    /// CXSetMutedCallAction handler (in ExpoCallKitModule.swift) calls this
    /// so the SwiftUI mic-button @Published flag flips even if the JS round
    /// trip is still pending.
    func setMutedFromProvider(uuid: UUID, muted: Bool) {
        DispatchQueue.main.async {
            self.isMuted = muted
        }
    }

    /// CXEndCallAction handler calls this to flip phase to `.ended` and stop
    /// the duration timer. Idempotent vs. the VC's own teardown.
    func markEnded(uuid: UUID?) {
        DispatchQueue.main.async {
            self.phase = .ended
            self.statusText = NativeCallPhase.ended.ptBR
            self.tickTimer?.invalidate()
            self.tickTimer = nil
            self.startedAt = nil
            self.activeCallUUID = nil
            self.activeCallId = nil
        }
    }
}
