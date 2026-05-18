// RNNoiseAudioProcessor — ML noise suppression replacement for Krisp on iOS.
//
// Open-source RNNoise (Xiph, BSD license — https://github.com/xiph/rnnoise). On iOS we
// integrate as a Swift Package (see manual Xcode steps documented at the bottom of this
// file). The package surfaces a tiny C-shim:
//
//   - rnnoise_create() -> OpaquePointer
//   - rnnoise_process_frame(handle, output: UnsafeMutablePointer<Float>,
//                                   input: UnsafePointer<Float>) -> Float
//   - rnnoise_destroy(handle)
//
// LiveKit Swift exposes a custom AudioProcessor via the
// `Room(audioProcessor:)` initializer (LiveKitClient 2.x). The processor's
// `process(audioFrame:)` is called on every captured WebRTC PCM frame at
// 48 kHz mono int16; we convert to float, run RNNoise, and write back. Frame
// size is exactly 480 samples (10 ms). Partial frames are buffered between
// calls — same logic as Android.
//
// Per-user toggle persists in App Group UserDefaults (key `rnnoise_enabled`,
// default true). The processor stays alive for the life of the process so
// new Rooms inherit the latest toggle state.
//
// IMPORTANT — Swift Package integration (manual Xcode step required, see
// MANUAL STEPS at the bottom): we cannot add a Swift Package via CocoaPods
// post_install. The developer must, on a Mac with Xcode open, add
// https://github.com/xiph/rnnoise (or a community Swift wrapper) as a SPM
// dependency for both `OneMundoMail` and `ChatyyBroadcastExtension` targets.
// Until that happens, the symbols below resolve to dlsym lookups so the app
// still links — the processor falls back to a no-op pass-through if the
// dynamic library isn't on the link path.

import Foundation
import os.log

@objc public final class RNNoiseAudioProcessor: NSObject {

    public static let shared = RNNoiseAudioProcessor()

    /// User-controlled. Default ON to match parity expectations from the JS
    /// `noiseSuppression: true` constraint and Krisp's default. Persisted to
    /// App Group UserDefaults under the suite group.com.onemundo.mail.
    @objc public var enabled: Bool {
        get {
            let ud = UserDefaults(suiteName: "group.com.onemundo.mail")
            return ud?.object(forKey: "rnnoise_enabled") as? Bool ?? true
        }
        set {
            let ud = UserDefaults(suiteName: "group.com.onemundo.mail")
            ud?.set(newValue, forKey: "rnnoise_enabled")
        }
    }

    /// True once the rnnoise dynamic symbols were resolved and the session
    /// was allocated. False = run as pass-through.
    @objc public private(set) var available: Bool = false

    private let frameSize = 480
    private let log = OSLog(subsystem: "com.onemundo.mail", category: "RNNoise")

    /// Opaque RNNoise denoise state.
    private var handle: OpaquePointer?

    /// Tail buffer carrying partial frames between process calls.
    private var tail: [Float] = []

    /// Function pointers resolved via dlsym at init. Nil → SPM not added yet
    /// (or symbol stripped); processor falls back to pass-through.
    private typealias CreateFn = @convention(c) () -> OpaquePointer?
    private typealias ProcessFn = @convention(c) (OpaquePointer?, UnsafeMutablePointer<Float>, UnsafePointer<Float>) -> Float
    private typealias DestroyFn = @convention(c) (OpaquePointer?) -> Void

    private var createFn: CreateFn?
    private var processFn: ProcessFn?
    private var destroyFn: DestroyFn?

    private override init() {
        super.init()
        resolveSymbols()
        if let create = createFn {
            handle = create()
            available = handle != nil
        }
        if available {
            os_log("RNNoise session ready", log: log, type: .info)
        } else {
            os_log("RNNoise unavailable — pass-through fallback", log: log, type: .info)
        }
    }

    deinit {
        if let h = handle, let destroy = destroyFn {
            destroy(h)
        }
    }

    /// Resolve rnnoise_create/process_frame/destroy via dlsym from RTLD_DEFAULT
    /// so we don't hard-link against a framework that may or may not be added
    /// as an SPM dependency yet.
    private func resolveSymbols() {
        let createSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "rnnoise_create")
        let procSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "rnnoise_process_frame")
        let destSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "rnnoise_destroy")
        if let c = createSym, let p = procSym, let d = destSym {
            createFn = unsafeBitCast(c, to: CreateFn.self)
            processFn = unsafeBitCast(p, to: ProcessFn.self)
            destroyFn = unsafeBitCast(d, to: DestroyFn.self)
        }
    }

    /// Process a chunk of int16 PCM samples in place. Mono, 48 kHz. Disabled
    /// or unavailable → no-op.
    ///
    /// Frame logic mirrors the Android RNNoiseProcessor: we accumulate any
    /// trailing partial frame in `tail` and only call rnnoise_process_frame on
    /// full 480-sample windows. Output is written back into the same buffer
    /// at the position it was read from so the WebRTC int16 buffer stays
    /// in-place — that's the contract LiveKit's AudioProcessor expects.
    @objc public func processInt16(_ buffer: UnsafeMutablePointer<Int16>, count: Int) {
        guard enabled, available, handle != nil, let process = processFn else { return }

        // Convert to float [-32768..32767] -> [-32768..32767] (RNNoise wants float
        // in the same int16 range, not [-1..1]).
        var floats = [Float](repeating: 0, count: count)
        for i in 0..<count {
            floats[i] = Float(buffer[i])
        }

        // Drain tail to align with frame boundary.
        var idx = 0
        if !tail.isEmpty {
            let need = frameSize - tail.count
            let take = min(need, count)
            tail.append(contentsOf: floats[0..<take])
            idx += take
            if tail.count == frameSize {
                var output = [Float](repeating: 0, count: frameSize)
                tail.withUnsafeBufferPointer { inPtr in
                    output.withUnsafeMutableBufferPointer { outPtr in
                        _ = process(handle, outPtr.baseAddress!, inPtr.baseAddress!)
                    }
                }
                // Copy denoised tail back to caller's buffer at the bytes we consumed.
                for i in 0..<take {
                    buffer[i] = Int16(clamping: Int(output[output.count - take + i]))
                }
                tail.removeAll(keepingCapacity: true)
            }
        }

        // Process full 480-sample frames.
        while count - idx >= frameSize {
            var input = [Float](repeating: 0, count: frameSize)
            var output = [Float](repeating: 0, count: frameSize)
            for i in 0..<frameSize { input[i] = floats[idx + i] }
            input.withUnsafeBufferPointer { inPtr in
                output.withUnsafeMutableBufferPointer { outPtr in
                    _ = process(handle, outPtr.baseAddress!, inPtr.baseAddress!)
                }
            }
            for i in 0..<frameSize {
                buffer[idx + i] = Int16(clamping: Int(output[i]))
            }
            idx += frameSize
        }

        // Stash leftover.
        if idx < count {
            for i in idx..<count {
                tail.append(floats[i])
            }
        }
    }
}

// MARK: - LiveKit AudioCustomProcessingDelegate bridge
//
// LiveKit Swift exposes `AudioCustomProcessingDelegate` (LK 2.0+). Implementations
// pass an AudioFrame; we extract the int16 PCM and pipe it through
// RNNoiseAudioProcessor.shared.processInt16. The Room is configured with this
// delegate via Room.audioProcessor in ExpoCallKitModule.setup.

#if canImport(LiveKitClient)
import LiveKitClient

@objc final class RNNoiseLKAdapter: NSObject {
    static let shared = RNNoiseLKAdapter()

    /// LiveKit calls this on its audio thread. We forward into the
    /// shared processor and respect the global toggle.
    ///
    /// Signature deliberately loose (Any) so this file compiles even if the
    /// LiveKit Swift SDK changes the AudioFrame shape across revisions —
    /// the cast falls back to no-op if the runtime type doesn't match.
    func process(audioFrame: Any) {
        guard RNNoiseAudioProcessor.shared.enabled,
              RNNoiseAudioProcessor.shared.available else { return }

        // Best-effort reflective access to the int16 samples + count. LK Swift
        // exposes these as `audioBuffer` (UnsafeMutablePointer<Int16>) +
        // `numberOfFrames: Int` in current builds. We use Mirror to dig them
        // out so a signature swap doesn't break the build.
        let mirror = Mirror(reflecting: audioFrame)
        var bufPtr: UnsafeMutablePointer<Int16>? = nil
        var frames: Int = 0
        for child in mirror.children {
            if child.label == "audioBuffer", let p = child.value as? UnsafeMutablePointer<Int16> {
                bufPtr = p
            }
            if child.label == "numberOfFrames", let n = child.value as? Int {
                frames = n
            }
        }
        if let p = bufPtr, frames > 0 {
            RNNoiseAudioProcessor.shared.processInt16(p, count: frames)
        }
    }
}
#endif

// MARK: - MANUAL STEPS (one-time, requires Mac + Xcode)
//
// 1. Open ios/OneMundoMail.xcworkspace in Xcode (15+).
// 2. File → Add Package Dependencies… → enter:
//        https://github.com/xiph/rnnoise
//    or a community Swift wrapper (e.g.
//        https://github.com/livekit-contrib/rnnoise-swift if available)
//    and add the `RNNoise` library product to BOTH targets:
//        - OneMundoMail
//        - ChatyyBroadcastExtension
// 3. Verify the package's static library exports `rnnoise_create`,
//    `rnnoise_process_frame`, and `rnnoise_destroy` (symbol names checked
//    via `nm` if unsure). The dlsym(RTLD_DEFAULT, ...) resolver in
//    `resolveSymbols()` picks them up automatically once linked.
// 4. Build & run — the OSLog "RNNoise session ready" line should appear in
//    Console.app under com.onemundo.mail/RNNoise.
//
// No CocoaPods step required for RNNoise itself; the Podfile entry for
// LiveKitClient is unchanged.
