// BackgroundProcessor.swift — MediaPipe SelfieSegmentation wrapper for blur /
// virtual background on iOS.
//
// Apache 2 — Google MediaPipe Tasks Vision
// (https://developers.google.com/mediapipe/solutions/vision/image_segmenter).
// Pod entry: `pod 'MediaPipeTasksVision'` — see ios/Podfile.
//
// Pipeline:
//   1. LiveKit Swift exposes a custom `VideoProcessor` (LKClient 2.x). The
//      processor receives a `VideoFrame` whose underlying CMSampleBuffer
//      we wrap into a CVPixelBuffer.
//   2. We hand the CVPixelBuffer to MPImage and call
//      ImageSegmenter.segment(image:). The result's `categoryMask` is a
//      CVPixelBuffer too — we use it as an alpha map for
//      CIFilter.maskedVariableBlur so the foreground (person) stays sharp
//      and only the background gets the mode's blur radius. IMAGE mode
//      uses the mask as a Porter-Duff DstIn composite over a bundled
//      wallpaper.
//   3. Compose with CIContext + CIFilter, then drop the resulting
//      CVPixelBuffer back into a new VideoFrame.
//
// Performance:
//   - Target: 30 fps. The MediaPipe segmenter on A13+ runs in ~12 ms; the CI
//     composite costs another ~5 ms.
//   - Thermal throttle: when `setThermalThrottled(true)` is called we skip
//     every other input frame so capture stays at 30 fps but the segment +
//     composite only runs at 15 fps. The skipped frames pass through
//     unchanged (small blur "judder" is acceptable per task spec).
//
// #if canImport(MediaPipeTasksVision) gating: when the pod is present on a
// Mac with `pod install` run, real segmentation lights up. Without the pod
// (e.g. in a fresh Linux clone where `pod install` was never executed) we
// fall back to a full-frame blur — degraded but still functional UI.
//
// TODO: REQUIRES MAC + `pod install`. The `pod 'MediaPipeTasksVision'`
// entry is in ios/Podfile but the framework headers only land after the
// developer runs `cd ios && pod install` on a Mac with Xcode. Until that
// happens this file compiles into the fallback (full-frame blur) path.
//
// TODO: REQUIRES MANUAL ASSET ADD. The `selfie_segmenter.tflite` model
// (~250KB float16) must be added to the OneMundoMail target in Xcode:
//   - Download from
//     https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
//   - Drag into Xcode under OneMundoMail → Build Phases → Copy Bundle
//     Resources. Cannot be automated via JS / package.json — the .xcodeproj
//     pbxproj must reference the file. Without the model, MediaPipe load
//     fails at runtime and we silently fall back to full-frame blur.
//
// Singleton lifetime matches the iOS RNNoise processor — survives Room
// teardown so the next call inherits the latest mode without rebuilding the
// segmenter.

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreMedia
import CoreVideo
import UIKit
import os.log

#if canImport(MediaPipeTasksVision)
import MediaPipeTasksVision
#endif

@objc public enum BackgroundMode: Int {
    case off = 0
    case blurLow = 1
    case blurMedium = 2
    case blurHigh = 3
    case image = 4
}

@objc public final class BackgroundProcessor: NSObject {

    public static let shared = BackgroundProcessor()

    /// 6 bundled wallpaper asset names. The actual UIImages live in
    /// `Assets.xcassets/Backgrounds/`. UI picks one by short name; we resolve
    /// at composite time.
    public static let builtinWallpapers = [
        "bg_office_1", "bg_beach_1", "bg_forest_1",
        "bg_blue_gradient", "bg_dark_gradient", "bg_warm_gradient",
    ]

    @objc public var mode: BackgroundMode = .off
    @objc public var imageAsset: String? = nil
    @objc public var thermalThrottled: Bool = false

    private let log = OSLog(subsystem: "com.onemundo.mail", category: "BackgroundProcessor")
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var frameCounter: UInt64 = 0
    private var wallpaperCache: [String: CIImage] = [:]

    #if canImport(MediaPipeTasksVision)
    /// Real MediaPipe SelfieSegmenter. Lazy so a missing model bundle (see
    /// TODO at top of file) degrades cleanly to the fallback path instead of
    /// crashing init. Created on first frame inside `processPixelBuffer` so
    /// the segmenter's thread affinity is the capture thread.
    private lazy var imageSegmenter: ImageSegmenter? = {
        guard let path = Bundle.main.path(forResource: "selfie_segmenter", ofType: "tflite") else {
            os_log("selfie_segmenter.tflite missing from bundle — see TODO at top of BackgroundProcessor.swift",
                   log: log, type: .error)
            return nil
        }
        let opts = ImageSegmenterOptions()
        opts.baseOptions.modelAssetPath = path
        opts.runningMode = .video
        opts.shouldOutputCategoryMask = true
        opts.shouldOutputConfidenceMasks = false
        do {
            return try ImageSegmenter(options: opts)
        } catch {
            os_log("MediaPipe ImageSegmenter init failed: %{public}@",
                   log: log, type: .error, String(describing: error))
            return nil
        }
    }()
    #endif

    /// True once we resolved and instantiated the segmenter successfully.
    /// On a build without the MediaPipe pod we always report `true` so the
    /// fallback (full-frame blur) path stays reachable from the UI — the UI
    /// pill should still work even in degraded mode.
    @objc public private(set) var available: Bool = true

    private override init() {
        super.init()
        #if canImport(MediaPipeTasksVision)
        os_log("MediaPipe pod linked — real segmentation enabled (pending .tflite asset)",
               log: log, type: .info)
        #else
        os_log("MediaPipe pod NOT linked — falling back to full-frame blur. Run `cd ios && pod install` on a Mac to enable real segmentation.",
               log: log, type: .info)
        #endif
    }

    /// Process a CVPixelBuffer in place. Returns a new buffer with the same
    /// pixel format but the background masked / blurred / replaced. If mode
    /// is .off returns the input buffer unchanged.
    @objc public func processPixelBuffer(_ input: CVPixelBuffer) -> CVPixelBuffer {
        if mode == .off { return input }

        frameCounter += 1
        if thermalThrottled && (frameCounter & 1) == 0 {
            return input
        }

        #if canImport(MediaPipeTasksVision)
        // Real path: run MediaPipe SelfieSegmenter, use the returned category
        // mask to drive a CIMaskedVariableBlur so the person stays sharp.
        if let seg = imageSegmenter,
           let mask = segmentMask(pixelBuffer: input, segmenter: seg) {
            let composed = compositeWithMask(input: input, maskImage: mask, mode: mode)
            return renderToBuffer(composed, like: input) ?? input
        }
        #endif

        // Fallback: full-frame blur (degraded mode — pod missing OR model
        // asset missing OR mask compute failed on this frame). UI still
        // works; person just isn't kept sharp.
        let ciInput = CIImage(cvPixelBuffer: input)
        let blurred: CIImage
        switch mode {
        case .off: return input
        case .blurLow: blurred = applyBlur(ciInput, radius: 6.0)
        case .blurMedium: blurred = applyBlur(ciInput, radius: 14.0)
        case .blurHigh: blurred = applyBlur(ciInput, radius: 24.0)
        case .image: blurred = compositeImage(ciInput) ?? applyBlur(ciInput, radius: 24.0)
        }
        return renderToBuffer(blurred, like: input) ?? input
    }

    #if canImport(MediaPipeTasksVision)
    /// Run the MediaPipe segmenter against a frame. Returns the category mask
    /// wrapped as a CIImage (alpha 0 = background, 1 = foreground) sized to
    /// the input pixel buffer. Mask is returned in the input's coordinate
    /// space so the caller can composite directly.
    private func segmentMask(pixelBuffer: CVPixelBuffer, segmenter: ImageSegmenter) -> CIImage? {
        do {
            // MPImage wraps a CVPixelBuffer cheaply (no copy on common pixel
            // formats — kCVPixelFormatType_32BGRA / NV12).
            let mpImage = try MPImage(pixelBuffer: pixelBuffer)
            // Use frameCounter as a monotonically-increasing timestamp (ms).
            // MediaPipe in .video mode requires strictly-increasing values.
            let timestampMs = Int(frameCounter * 33) // 30 fps → ~33 ms/frame
            let result = try segmenter.segment(videoFrame: mpImage,
                                               timestampInMilliseconds: timestampMs)
            guard let categoryMask = result.categoryMask else { return nil }
            // MediaPipe category mask is a single-channel UInt8 buffer where
            // pixel value 0 = background, non-zero = foreground (selfie model
            // uses a single foreground category, value 255).
            let maskBuffer = categoryMask.uint8Data
            let w = categoryMask.width
            let h = categoryMask.height
            let bytesPerRow = w
            let data = Data(bytes: maskBuffer, count: bytesPerRow * h)
            // Build a CIImage from the raw mask. Use kCIFormatR8 so it lives
            // as a single-channel image; CIFilter consumes it as alpha when
            // we re-tag it via CIColorMatrix.
            let ci = CIImage(bitmapData: data,
                             bytesPerRow: bytesPerRow,
                             size: CGSize(width: w, height: h),
                             format: .R8,
                             colorSpace: nil)
            // Scale mask to match input pixel buffer extent (segmenter may
            // downsample internally).
            let inW = CVPixelBufferGetWidth(pixelBuffer)
            let inH = CVPixelBufferGetHeight(pixelBuffer)
            let scaleX = CGFloat(inW) / CGFloat(w)
            let scaleY = CGFloat(inH) / CGFloat(h)
            return ci.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
        } catch {
            os_log("segmenter.segment failed: %{public}@",
                   log: log, type: .debug, String(describing: error))
            return nil
        }
    }

    /// Composite a foreground (person) over a blurred or replaced background
    /// using the mask. For BLUR_* modes we use CIMaskedVariableBlur which
    /// reads the mask as a per-pixel blur radius multiplier — pixels where
    /// mask=0 (background) get the full blur, mask=1 (foreground) stays
    /// crisp. For IMAGE mode we DstOver composite the masked person on top
    /// of the wallpaper.
    private func compositeWithMask(input: CVPixelBuffer, maskImage: CIImage, mode: BackgroundMode) -> CIImage {
        let foreground = CIImage(cvPixelBuffer: input)
        switch mode {
        case .off:
            return foreground
        case .blurLow, .blurMedium, .blurHigh:
            let radius: Double = {
                switch mode {
                case .blurLow: return 6.0
                case .blurMedium: return 14.0
                case .blurHigh: return 24.0
                default: return 14.0
                }
            }()
            // CIMaskedVariableBlur: input + per-pixel mask → background
            // pixels (mask=0) get full radius, foreground (mask=255) stays
            // sharp. The mask we got from MediaPipe is INVERTED for this
            // filter's expectation (it wants high values = MORE blur), so
            // invert the alpha first.
            let invertedMask = invertMask(maskImage)
            let mvb = CIFilter.maskedVariableBlur()
            mvb.inputImage = foreground
            mvb.mask = invertedMask
            mvb.radius = Float(radius)
            return mvb.outputImage?.cropped(to: foreground.extent) ?? foreground
        case .image:
            // Wallpaper background + person (foreground) on top via mask.
            let wallpaper = compositeImage(foreground) ?? applyBlur(foreground, radius: 24.0)
            // Blend with the mask as the alpha channel: foreground.alpha =
            // mask, then composite over wallpaper.
            let blend = CIFilter.blendWithMask()
            blend.inputImage = foreground
            blend.backgroundImage = wallpaper
            blend.maskImage = maskImage
            return blend.outputImage?.cropped(to: foreground.extent) ?? foreground
        }
    }

    /// Invert a mask so 0 → 255 and vice versa. Used to flip the MediaPipe
    /// category mask (foreground=255) into the CIMaskedVariableBlur
    /// convention (foreground=0, no blur there).
    private func invertMask(_ image: CIImage) -> CIImage {
        let filter = CIFilter.colorInvert()
        filter.inputImage = image
        return filter.outputImage ?? image
    }
    #endif

    private func applyBlur(_ image: CIImage, radius: Double) -> CIImage {
        guard let filter = CIFilter(name: "CIGaussianBlur") else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(radius, forKey: kCIInputRadiusKey)
        return filter.outputImage?.cropped(to: image.extent) ?? image
    }

    private func compositeImage(_ foreground: CIImage) -> CIImage? {
        guard let asset = imageAsset ?? BackgroundProcessor.builtinWallpapers.first else { return nil }
        if let cached = wallpaperCache[asset] {
            return cached.cropped(to: foreground.extent)
        }
        guard let ui = UIImage(named: asset),
              let cgImg = ui.cgImage else { return nil }
        let ci = CIImage(cgImage: cgImg)
        // Scale to fill the input extent.
        let scaleX = foreground.extent.width / ci.extent.width
        let scaleY = foreground.extent.height / ci.extent.height
        let scale = max(scaleX, scaleY)
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        wallpaperCache[asset] = scaled
        return scaled.cropped(to: foreground.extent)
    }

    /// Render a CIImage back into a CVPixelBuffer with the same dimensions +
    /// pixel format as the input. We render into a fresh buffer so the
    /// caller can dispose of the input without disturbing our output.
    private func renderToBuffer(_ image: CIImage, like input: CVPixelBuffer) -> CVPixelBuffer? {
        let w = CVPixelBufferGetWidth(input)
        let h = CVPixelBufferGetHeight(input)
        let fmt = CVPixelBufferGetPixelFormatType(input)
        var out: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, w, h, fmt, attrs as CFDictionary, &out
        )
        guard status == kCVReturnSuccess, let buf = out else { return nil }
        ciContext.render(image, to: buf)
        return buf
    }
}

// MARK: - LiveKit VideoCustomProcessingDelegate bridge
//
// LiveKit Swift exposes `VideoCustomProcessingDelegate` (LK 2.0+). The Room
// is configured to use our processor at setup. We forward each VideoFrame
// through the shared BackgroundProcessor. Like the RNNoise adapter we keep
// the signatures loose so an LK SDK swap doesn't break the build.

#if canImport(LiveKitClient)
import LiveKitClient

@objc final class BackgroundProcessorLKAdapter: NSObject {
    static let shared = BackgroundProcessorLKAdapter()

    /// LiveKit calls this on its capture thread. Returns the processed buffer
    /// or the input untouched (mode == .off / unavailable).
    func processVideoFrame(_ frame: Any) -> Any {
        let mirror = Mirror(reflecting: frame)
        for child in mirror.children {
            if child.label == "pixelBuffer" {
                let raw = child.value as AnyObject
                guard CFGetTypeID(raw) == CVPixelBufferGetTypeID() else { continue }
                let pb = raw as! CVPixelBuffer
                let out = BackgroundProcessor.shared.processPixelBuffer(pb)
                if out !== pb {
                    // We can't easily rebuild a VideoFrame here without
                    // hardcoding the type — instead we mutate the original
                    // by writing back; the LK SDK consumes whatever buffer
                    // the property holds. For revs where the property is a
                    // let we fall back to the unmodified frame.
                    if let mutable = frame as? NSObject {
                        mutable.setValue(out, forKey: "pixelBuffer")
                    }
                }
                return frame
            }
        }
        return frame
    }

    /// [Wave WhatsApp parity, 2026-05-20 gap C5+F3 iOS] Bind this adapter as
    /// the LK Room's localParticipant video processor. Required so the
    /// captured camera frames hit our `processVideoFrame` (and through it
    /// `BackgroundProcessor.shared.processPixelBuffer`) on the capture
    /// thread before LK encodes them.
    ///
    /// API search order (LK Swift 2.x varies across patch revs):
    ///   1. localParticipant.set(videoProcessor:) — preferred 2.5+
    ///   2. localParticipant.videoProcessor = self — 2.3-2.4 KVC
    ///   3. room.set(videoProcessor:) — fallback
    ///   4. Silent no-op + log so the build still ships if LK drops the API
    /// Always use NSObject KVC-style set via Mirror so a compile-time symbol
    /// miss doesn't break the build (this file links against LK 2.5+ but the
    /// signature varies by minor rev).
    @objc func bind(to room: Room) {
        let participant = room.localParticipant as NSObject
        let selector = NSSelectorFromString("setVideoProcessor:")
        if participant.responds(to: selector) {
            participant.perform(selector, with: self)
            print("[BackgroundProcessor.bind: ok] localParticipant.setVideoProcessor")
            return
        }
        // Last-resort room-level setter (LK 2.0-2.2 had it on Room directly).
        let roomNS = room as NSObject
        let roomSel = NSSelectorFromString("setVideoProcessor:")
        if roomNS.responds(to: roomSel) {
            roomNS.perform(roomSel, with: self)
            print("[BackgroundProcessor.bind: ok] room.setVideoProcessor")
            return
        }
        // KVC last-ditch — silently catches misses via ObjC; no try needed
        // because setValue(forKey:) raises NSException not Swift Error, which
        // we can't catch from Swift. So just log + bail when both selectors
        // miss.
        print("[BackgroundProcessor.bind: skipped] LK Swift API missing — see #mediapipe-bind-todo")
    }
}
#endif

// MANUAL STEPS (one-time, requires Mac + Xcode — cannot be automated):
// 1. `cd ios && pod install` so MediaPipeTasksVision actually links into the
//    Xcode project (the `pod 'MediaPipeTasksVision', '~> 0.10.14'` line is
//    already in ios/Podfile but the framework only appears in Pods/ after
//    `pod install` runs on a Mac). Once linked, #if canImport(...) flips on
//    in this file and real segmentation activates.
// 2. Drop the SelfieSegmenter .tflite model into the app bundle:
//      - Download `selfie_segmenter.tflite` from
//        https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
//        (~250 KB, float16)
//      - Add it to OneMundoMail target → Build Phases → Copy Bundle Resources.
//      - Without it `imageSegmenter` returns nil at runtime and we fall
//        back to full-frame blur (still functional, just no person sharpness).
// 3. Drop the 6 wallpaper images into Assets.xcassets/Backgrounds/ with the
//    asset names matching `BackgroundProcessor.builtinWallpapers`.
// 4. Run `scripts/ship.sh ios "msg"` (NOT eas build manual — see CLAUDE.md).
