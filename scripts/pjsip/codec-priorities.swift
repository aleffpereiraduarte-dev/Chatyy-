// codec-priorities.swift
//
// Runtime codec configuration for PJSUA. Called once during PJSUA init, after
// pjsua_init() but before pjsua_start(). Mirrors the WhatsApp-style profile
// from docs/whatsapp-migration/01-pjsip-ios.md §5.
//
// This file is a SHIM ONLY — it depends on a C-side bridge (PJSipBridge.mm)
// that will be added in Phase 2. The bridge is required because pjsua_*
// symbols are not visible to Swift directly (no module map for the C headers
// yet). Until Phase 2 lands, this file does NOT compile against the Xcode
// project — it lives here as a reference for the bridging code to import.
//
// Usage (Phase 2):
//   let session = PJSipSession.shared
//   try session.startup()
//   try ChatyyCodecPriorities.apply()   // ← this file
//   try session.registerAccount(...)
//
// See:
//   - docs/whatsapp-migration/01-pjsip-ios.md §5 (codec config)
//   - scripts/pjsip/pjsip-config-site.h (compile-time defaults)

import Foundation

/// Apply Chatyy's codec priority profile + Opus tuning.
///
/// Profile (WhatsApp parity):
///   - Opus 16 kHz mono, 20 kbps, 20 ms ptime, FEC + DTX  → priority 255
///   - SILK 16 kHz mono                                    → priority 128
///   - PCMU 8 kHz mono (last-resort)                       → priority 64
///   - H.264 Constrained Baseline 3.1 (profile-level-id 42e01f) → priority 255
///   - VP8 fallback                                        → priority 128
///
/// All other codecs disabled (priority 0). This matches the compile-time
/// disables in `pjsip-config-site.h` but is re-asserted at runtime in case
/// a future PJSIP version adds new codecs by default.
public enum ChatyyCodecPriorities {

    public enum CodecError: Error {
        case bridgeNotLinked
        case audioCodecConfigFailed(String, Int32)
        case videoCodecConfigFailed(String, Int32)
        case opusParamsFailed(Int32)
    }

    /// Apply audio + video codec configuration.
    ///
    /// MUST be called from the PJSIP thread (the bridge serial queue). Call
    /// from `PJSipSession.applyCodecConfig()` after `pjsua_init()` succeeds.
    public static func apply() throws {
        try applyAudio()
        try applyVideo()
    }

    // MARK: - Audio

    private static func applyAudio() throws {
        // 1. Zero everything.
        try setPriority(audioCodec: "*", priority: 0)

        // 2. Opus first.
        try setPriority(audioCodec: "opus/48000/2", priority: 255)
        try tuneOpus()

        // 3. SILK fallback. PJSIP exposes SILK at 8/12/16/24 kHz — we only enable 16k mono.
        try setPriority(audioCodec: "SILK/16000", priority: 128)

        // 4. PCMU last-resort. ITU G.711 is on every endpoint and stays for legacy SIP gateways.
        try setPriority(audioCodec: "PCMU/8000", priority: 64)
    }

    /// Tune Opus to WhatsApp wire format:
    ///   maxplaybackrate=16000, sprop-maxcapturerate=16000,
    ///   maxaveragebitrate=20000, useinbandfec=1, usedtx=1, stereo=0,
    ///   frm_per_pkt=1 (20 ms ptime), vad=1, plc=1
    private static func tuneOpus() throws {
        let codec = "opus/48000/2"
        let fmtp = [
            "maxplaybackrate=16000",
            "sprop-maxcapturerate=16000",
            "maxaveragebitrate=20000",
            "useinbandfec=1",
            "usedtx=1",
            "stereo=0",
            "cbr=0",
        ].joined(separator: ";")

        let rc = PJSipBridgeShim.tuneOpus(
            codecId: codec,
            fmtp: fmtp,
            framesPerPacket: 1,
            vad: true,
            plc: true,
            packetLossPercent: 10
        )
        guard rc == 0 else { throw CodecError.opusParamsFailed(rc) }
    }

    // MARK: - Video

    private static func applyVideo() throws {
        try setPriority(videoCodec: "*", priority: 0)
        try setPriority(videoCodec: "H264", priority: 255)
        // H.264 fmtp — profile-level-id=42e01f (Constrained Baseline 3.1),
        // packetization-mode=1 (non-interleaved). Applied via the bridge.
        let rc = PJSipBridgeShim.tuneH264(
            profileLevelId: "42e01f",
            packetizationMode: 1,
            maxMbps: 245760,   // ~720p30
            maxBr: 2000,       // 2 Mbps
            maxFs: 8192        // max frame size in macroblocks
        )
        guard rc == 0 else { throw CodecError.videoCodecConfigFailed("H264", rc) }

        try setPriority(videoCodec: "VP8", priority: 128)
    }

    // MARK: - Bridge calls

    private static func setPriority(audioCodec id: String, priority: UInt8) throws {
        let rc = PJSipBridgeShim.setAudioCodecPriority(codecId: id, priority: priority)
        guard rc == 0 else { throw CodecError.audioCodecConfigFailed(id, rc) }
    }

    private static func setPriority(videoCodec id: String, priority: UInt8) throws {
        let rc = PJSipBridgeShim.setVideoCodecPriority(codecId: id, priority: priority)
        guard rc == 0 else { throw CodecError.videoCodecConfigFailed(id, rc) }
    }
}

// -----------------------------------------------------------------------------
// MARK: - Bridge shim contract
//
// Implemented by `ios/PJSipBridge.mm` (Phase 2). Listed here as a Swift protocol
// for documentation + compile-time contract. The real bridge is class methods
// on an Obj-C++ class exposed via a module header.
// -----------------------------------------------------------------------------

/// Contract that PJSipBridge.mm must satisfy. NOT instantiable from Swift —
/// the bridge is purely static + thread-confined to a serial PJSIP queue.
///
/// All methods return `0` on success, or a non-zero `pj_status_t` on failure.
public protocol PJSipBridgeShimContract {
    /// pjsua_codec_set_priority(pj_str(codecId), priority)
    static func setAudioCodecPriority(codecId: String, priority: UInt8) -> Int32

    /// pjsua_vid_codec_set_priority(pj_str(codecId), priority)
    static func setVideoCodecPriority(codecId: String, priority: UInt8) -> Int32

    /// Opus tuning — wraps pjsua_codec_get_param + mutate + pjsua_codec_set_param.
    static func tuneOpus(
        codecId: String,
        fmtp: String,
        framesPerPacket: UInt32,
        vad: Bool,
        plc: Bool,
        packetLossPercent: UInt32
    ) -> Int32

    /// H.264 tuning via pjmedia_vid_codec_param + pjsua_vid_codec_set_param.
    static func tuneH264(
        profileLevelId: String,
        packetizationMode: UInt32,
        maxMbps: UInt32,
        maxBr: UInt32,
        maxFs: UInt32
    ) -> Int32
}

/// Phase-1 stub. Replaced by the real Obj-C++ class in Phase 2 (added as an
/// `@objc(PJSipBridgeShim) class` in PJSipBridge.mm with matching selector
/// signatures). Until then, all calls throw via the do/catch above so the
/// callsite is exercised in unit tests without a working PJSIP.
public enum PJSipBridgeShim: PJSipBridgeShimContract {
    public static func setAudioCodecPriority(codecId: String, priority: UInt8) -> Int32 {
        return -1 /* PJ_EUNSUPPORTED */
    }
    public static func setVideoCodecPriority(codecId: String, priority: UInt8) -> Int32 {
        return -1
    }
    public static func tuneOpus(
        codecId: String,
        fmtp: String,
        framesPerPacket: UInt32,
        vad: Bool,
        plc: Bool,
        packetLossPercent: UInt32
    ) -> Int32 {
        return -1
    }
    public static func tuneH264(
        profileLevelId: String,
        packetizationMode: UInt32,
        maxMbps: UInt32,
        maxBr: UInt32,
        maxFs: UInt32
    ) -> Int32 {
        return -1
    }
}
