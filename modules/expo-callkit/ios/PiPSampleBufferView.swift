// PiPSampleBufferView.swift — [2026-10-07 ios-native] call Picture-in-Picture
// rendering, split out of CallViewController.swift.
//
// What changed vs. the Stage #993 renderer (which lived at the bottom of
// CallViewController.swift):
//   1. I420 frames are no longer dropped. VP8/VP9 (software-decoded — e.g. an
//      Android peer that negotiated VP8) and some simulcast layers arrive as
//      `I420VideoBuffer`, not `CVPixelVideoBuffer`; the old renderer skipped
//      them, so the PiP window stayed BLACK for those peers. We now use
//      LiveKit's public `VideoFrame.toCVPixelBuffer()` (LiveKitClient 2.0.18:
//      CVPixelVideoBuffer → as-is, I420VideoBuffer → libyuv conversion). The
//      conversion costs CPU, so while PiP is NOT showing we only convert every
//      6th I420 frame (keeps a fresh "last frame" ready for the PiP start
//      animation) and go full-rate once PiP is active.
//   2. Rotation is honored. WebRTC delivers phone-camera frames with CVO
//      rotation metadata (90°/270° for a portrait sender) instead of rotating
//      pixels; the old layer showed them SIDEWAYS. The display layer is now
//      rotated by the frame's rotation inside PiPSampleBufferView.
//   3. The display layer follows its container. Before, the layer frame was
//      set once from pipVC.view.bounds at construction (sublayers don't
//      autoresize), so in the small PiP window the video was clipped/offset.
//   4. The PiP window aspect follows the remote video (preferredContentSize
//      updated whenever the displayed size / rotation changes).

import UIKit
import AVFoundation
import AVKit
import CoreMedia
import LiveKitClient

/// UIView hosting the AVSampleBufferDisplayLayer used as the content of the
/// AVPictureInPictureVideoCallViewController. Keeps the layer sized to the
/// view and rotated by the current frame rotation.
final class PiPSampleBufferView: UIView {
    let displayLayer = AVSampleBufferDisplayLayer()
    private(set) var rotationDegrees: Int = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        // Fill like WhatsApp's call PiP; the window aspect is matched to the
        // video via preferredContentSize so cropping is minimal.
        displayLayer.videoGravity = .resizeAspectFill
        displayLayer.backgroundColor = UIColor.black.cgColor
        layer.addSublayer(displayLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Main thread only.
    func setRotation(_ degrees: Int) {
        let norm = ((degrees % 360) + 360) % 360
        guard norm != rotationDegrees else { return }
        rotationDegrees = norm
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let b = bounds
        let swap = rotationDegrees == 90 || rotationDegrees == 270
        // bounds/position are independent of the affine transform, so set the
        // UNROTATED size and let the transform turn it into the view's box.
        displayLayer.bounds = CGRect(x: 0, y: 0,
                                     width: swap ? b.height : b.width,
                                     height: swap ? b.width : b.height)
        displayLayer.position = CGPoint(x: b.midX, y: b.midY)
        displayLayer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(rotationDegrees) * .pi / 180))
        CATransaction.commit()
    }
}

/// VideoRenderer that converts LiveKit frames into CMSampleBuffers and
/// enqueues them on the PiP display layer.
final class PiPVideoRenderer: NSObject, VideoRenderer {
    weak var displayLayer: AVSampleBufferDisplayLayer?
    /// Called on the MAIN thread when the rotation or the displayed size
    /// (post-rotation width x height) changes.
    var onFormatChange: ((_ rotationDegrees: Int, _ displaySize: CGSize) -> Void)?
    /// Set from the AVPictureInPictureControllerDelegate callbacks. Read on
    /// the WebRTC render thread — a stale read only affects one frame.
    var isPiPActive: Bool = false

    private var timebase: CMTimebase?
    private var lastRotation: Int = -1
    private var lastW: Int = 0
    private var lastH: Int = 0
    private var i420Counter: Int = 0

    var isAdaptiveStreamEnabled: Bool { false }
    var adaptiveStreamSize: CGSize { .zero }

    init(displayLayer: AVSampleBufferDisplayLayer) {
        self.displayLayer = displayLayer
        super.init()
        // Control timebase so the layer schedules frames against host time —
        // without it the layer can stall on the first enqueue.
        var tb: CMTimebase?
        CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault,
                                        sourceClock: CMClockGetHostTimeClock(),
                                        timebaseOut: &tb)
        if let tb {
            CMTimebaseSetTime(tb, time: .zero)
            CMTimebaseSetRate(tb, rate: 1.0)
            displayLayer.controlTimebase = tb
            self.timebase = tb
        }
    }

    func set(size: CGSize) {
        // No-op — the view lays the layer out.
    }

    func render(frame: VideoFrame) {
        guard displayLayer != nil else { return }

        let pixelBuffer: CVPixelBuffer
        if let cv = frame.buffer as? CVPixelVideoBuffer {
            pixelBuffer = cv.pixelBuffer
        } else {
            // I420 (software decoders). Throttle the conversion while PiP is
            // hidden — only a fresh last frame is needed for the start morph.
            i420Counter &+= 1
            if !isPiPActive && i420Counter % 6 != 0 { return }
            guard let converted = frame.toCVPixelBuffer() else { return }
            pixelBuffer = converted
        }

        // Rotation + displayed size → main-thread layout / PiP window aspect.
        let rotation = frame.rotation.rawValue
        let w = CVPixelBufferGetWidth(pixelBuffer)
        let h = CVPixelBufferGetHeight(pixelBuffer)
        if rotation != lastRotation || w != lastW || h != lastH {
            lastRotation = rotation
            lastW = w
            lastH = h
            let swap = rotation == 90 || rotation == 270
            let display = CGSize(width: swap ? h : w, height: swap ? w : h)
            let cb = onFormatChange
            DispatchQueue.main.async { cb?(rotation, display) }
        }

        var formatDescription: CMVideoFormatDescription?
        let fmtErr = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard fmtErr == noErr, let formatDesc = formatDescription else { return }

        // Host time for presentation (LiveKit's timestamp isn't guaranteed
        // monotonic across track switches) + DisplayImmediately below.
        let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: hostTime,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let sbErr = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDesc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        guard sbErr == noErr, let sample = sampleBuffer else { return }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
            if CFArrayGetCount(attachments) > 0 {
                let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
                CFDictionarySetValue(
                    dict,
                    Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                    Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
                )
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let layer = self?.displayLayer else { return }
            if layer.status == .failed {
                layer.flush()
            }
            layer.enqueue(sample)
        }
    }
}
