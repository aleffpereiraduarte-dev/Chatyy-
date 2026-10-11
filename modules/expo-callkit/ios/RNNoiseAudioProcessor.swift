// RNNoiseAudioProcessor — REAL ML noise suppression for native LiveKit calls.
//
// [2026-10-11 noise] Replaces the 2026-10-04 "honest disabled stub". RNNoise
// (Xiph/Mozilla, BSD-3) is now vendored as C in ./ChatyyNS (chatyy_ns.{h,c} +
// rnnoise/ v0.1.1, default model compiled in) and exposed to Swift through
// the pod's public header `chatyy_ns.h` (CocoaPods: Swift static-lib pods get
// `-import-underlying-module`, so the C functions are in scope without an
// import line).
//
// Hook point (verified in client-sdk-swift 2.0.18 sources):
//   AudioManager.shared.capturePostProcessingDelegate: AudioCustomProcessingDelegate?
//     → RTC.audioProcessingModule (the APM of the shared RTC factory, i.e. of
//       EVERY Room in the process) calls us once per 10 ms capture frame,
//       AFTER WebRTC's own AEC/NS/AGC + Apple VPIO. The SDK holds the target
//       WEAKLY → `shared` keeps us alive.
//   protocol AudioCustomProcessingDelegate (@objc):
//     audioProcessingInitialize(sampleRate:channels:)
//     audioProcessingProcess(audioBuffer: LKAudioBuffer)   // frames, channels, rawBuffer(forChannel:)
//     audioProcessingRelease()
//     optional audioProcessingName
//
// Because the hook is process-wide, it is installed by the CALL paths only
// (CallViewController / GroupCallViewController / NativeCallRoom preconnect)
// and removed by LiveBroadcastViewController so a live with music is never
// gated by a voice model.
//
// Failure-safety: allocation failure → `available == false` and install() is a
// no-op (pure WebRTC/VPIO path, exactly the previous behaviour). Per frame the
// C side passes through anything that is not mono 480-sample (48 kHz) audio,
// never blocks (try-lock), never allocates, and restores the raw frame on a
// non-finite output.
//
// User toggle: existing App Group pref `rnnoise_enabled` (default true), written
// by CallViewController.applyNoiseSuppression and ExpoCallKit.setNoiseSuppression.

import Foundation
import os.log
import LiveKitClient

@objc final class RNNoiseAudioProcessor: NSObject, AudioCustomProcessingDelegate {

    static let shared = RNNoiseAudioProcessor()

    static let prefsSuite = "group.com.onemundo.mail"
    static let prefsKey = "rnnoise_enabled"

    private let log = OSLog(subsystem: "com.onemundo.mail", category: "RNNoise")

    /// Native suppressor (chatyy_ns). nil ⇒ allocation failed ⇒ pass-through.
    private let ns: OpaquePointer?

    /// True when the RNNoise state was allocated (the model is compiled in).
    @objc var available: Bool { return ns != nil }

    /// Runtime on/off (atomic in C, read by the audio thread every frame).
    /// Does NOT persist — callers persist `rnnoise_enabled` themselves.
    @objc var enabled: Bool {
        get { return chatyy_ns_is_enabled() != 0 }
        set { chatyy_ns_set_enabled(newValue ? 1 : 0) }
    }

    private override init() {
        // chatyy_ns_create also pre-builds RNNoise's global tables, so this must
        // run off the audio thread — `shared` is first touched from install()
        // (main thread) or the ExpoCallKit module functions (JS thread).
        self.ns = chatyy_ns_create()
        super.init()
        enabled = Self.persistedEnabled()
        os_log("RNNoise ready=%{public}@ enabled=%{public}@", log: log, type: .info,
               ns != nil ? "yes" : "NO (pass-through)", enabled ? "yes" : "no")
    }

    /// Persisted user choice (default ON).
    static func persistedEnabled() -> Bool {
        return UserDefaults(suiteName: prefsSuite)?.object(forKey: prefsKey) as? Bool ?? true
    }

    // MARK: - Install / uninstall (call paths only)

    /// Attach to LiveKit's shared capture APM (idempotent). Call before the mic
    /// is published. Never throws; on any problem the call keeps WebRTC NS only.
    @objc static func install() {
        let p = shared
        p.enabled = persistedEnabled()
        guard p.ns != nil else {
            os_log("install skipped — RNNoise unavailable", log: p.log, type: .error)
            return
        }
        if (AudioManager.shared.capturePostProcessingDelegate as AnyObject?) !== p {
            AudioManager.shared.capturePostProcessingDelegate = p
            os_log("installed as LiveKit capturePostProcessingDelegate", log: p.log, type: .info)
        }
    }

    /// Detach (e.g. live broadcast: music must not go through a voice model).
    /// Only removes OUR delegate — never clobbers someone else's.
    @objc static func uninstall() {
        let p = shared
        if (AudioManager.shared.capturePostProcessingDelegate as AnyObject?) === p {
            AudioManager.shared.capturePostProcessingDelegate = nil
            os_log("uninstalled from LiveKit capture APM", log: p.log, type: .info)
        }
    }

    // MARK: - AudioCustomProcessingDelegate (WebRTC APM thread)

    @objc var audioProcessingName: String { return "chatyy_rnnoise" }

    @objc func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
        // New stream / rate: start the recurrent state clean (no allocation).
        if let ns = ns { chatyy_ns_reset(ns) }
    }

    @objc func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        // Mono only (LiveKit mic capture is mono); anything else passes through
        // so a stereo source never ends up with denoised-L / raw-R.
        guard let ns = ns, audioBuffer.channels == 1 else { return }
        let frames = audioBuffer.frames
        guard frames == 480 else { return } // 10 ms @ 48 kHz only (C re-checks)
        _ = chatyy_ns_process(ns, audioBuffer.rawBuffer(forChannel: 0), Int32(truncatingIfNeeded: frames))
    }

    @objc func audioProcessingRelease() {
        // State is owned by `shared` for the process lifetime (no free here, so
        // a late process() can never touch freed memory).
    }

    // MARK: - Legacy surface (kept so old call sites compile)

    /// Legacy int16 entry point — unused by LiveKit (which hands float buffers).
    @objc func processInt16(_ buffer: UnsafeMutablePointer<Int16>, count: Int) {
        // Intentionally a no-op: the LiveKit capture path above is the only
        // supported route. Kept for ABI/compile compatibility.
    }
}

// MARK: - LiveKit adapter (compat shim)

/// Kept for compatibility: binding to a Room == installing the process-wide
/// capture post-processor (LiveKit Swift has no per-Room processor API).
@objc final class RNNoiseLKAdapter: NSObject {
    static let shared = RNNoiseLKAdapter()

    @objc func bind(to room: Room) {
        RNNoiseAudioProcessor.install()
    }
}
