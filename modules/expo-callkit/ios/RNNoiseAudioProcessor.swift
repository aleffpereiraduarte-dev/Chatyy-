// RNNoiseAudioProcessor — HONEST DISABLED STUB.
//
// [2026-10-04 facade removal] This type used to advertise an "ML noise
// suppression" layer (open-source RNNoise, Xiph) wired into LiveKit's custom
// audio-processing delegate. In reality it was never active in any shipped
// build:
//
//   * The RNNoise Swift Package was never added in Xcode, so the
//     `dlsym(RTLD_DEFAULT, "rnnoise_*")` lookups ALWAYS failed → `available`
//     was ALWAYS false → `processInt16` was ALWAYS a no-op.
//   * `RNNoiseLKAdapter.bind(to:)` bailed on `available == false`, so it never
//     attached to a Room — and even if it had, LiveKit Swift does not expose
//     the `setAudioProcessor:` / `setAudioCustomProcessingDelegate:` selectors
//     this file probed for, so the Obj-C `perform(sel:)` would never match.
//
// The net effect: zero frames ever went through RNNoise, yet the code + UI
// claimed "noise suppression ON". That was theater.
//
// WHAT ACTUALLY SUPPRESSES NOISE (unchanged, untouched):
//   * Apple's Voice-Processing I/O (VPIO) audio unit — hardware AEC + NS, used
//     by the WebRTC audio device on iOS.
//   * WebRTC's own noise suppressor / AGC / echo canceller, enabled via
//     `defaultAudioCaptureOptions()` on the LiveKit RoomOptions
//     (CallViewController.defaultAudioCaptureOptions).
//
// That real path is what the user hears and it is NOT affected by this file.
//
// This stub stays only to keep the symbols referenced elsewhere compiling.
// It is intentionally, honestly disabled: `available == false`,
// `enabled == false`, `processInt16` is a no-op, and the LK adapter is a no-op.
// Nothing here claims to be running.

import Foundation
import os.log

@objc public final class RNNoiseAudioProcessor: NSObject {

    public static let shared = RNNoiseAudioProcessor()

    private let log = OSLog(subsystem: "com.onemundo.mail", category: "RNNoise")

    /// RNNoise is not integrated. This is always false. Real noise suppression
    /// comes from VPIO/HW-AEC + WebRTC's NS (see file header).
    @objc public private(set) var available: Bool = false

    /// Always false — there is no RNNoise processing to enable. The setter is a
    /// no-op so legacy call sites (`RNNoiseAudioProcessor.shared.enabled = x`)
    /// keep compiling without resurrecting the facade. WebRTC's built-in NS is
    /// controlled independently via the LiveKit audio capture options.
    @objc public var enabled: Bool {
        get { return false }
        set { /* no-op: RNNoise is not wired — see file header */ }
    }

    private override init() {
        super.init()
        os_log("RNNoise not integrated — disabled stub (real NS = VPIO/WebRTC)", log: log, type: .info)
    }

    /// No-op. RNNoise never ran; the int16 buffer is left untouched. Kept only
    /// so the (now also no-op) LK adapter below still compiles.
    @objc public func processInt16(_ buffer: UnsafeMutablePointer<Int16>, count: Int) {
        // Intentionally empty — RNNoise is not linked. Do not add per-frame work
        // here without actually wiring a real processor (see file header).
    }
}

// MARK: - LiveKit adapter (no-op)
//
// Retained as an honest no-op so any lingering reference compiles. It does NOT
// attach anything to the Room. Do not re-enable without a real, linked RNNoise
// (or equivalent) processor AND a verified LiveKit Swift custom-audio API.

#if canImport(LiveKitClient)
import LiveKitClient

@objc final class RNNoiseLKAdapter: NSObject {
    static let shared = RNNoiseLKAdapter()

    /// No-op. RNNoise is not integrated; binding would attach a passthrough at
    /// best. Left as a no-op so the WebRTC AEC/NS path (which is what actually
    /// works) owns audio processing uncontested.
    @objc func bind(to room: Room) {
        // Intentionally does nothing — see file header.
    }
}
#endif
