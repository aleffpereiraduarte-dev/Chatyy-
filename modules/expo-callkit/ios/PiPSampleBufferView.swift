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

    // [2026-10-14 pip-frozen] "Camera off" card shown INSTEAD of the video when
    // the remote picture stops (muted / unpublished / no frames). Without it the
    // AVSampleBufferDisplayLayer kept the LAST frame forever → a frozen face
    // floating over the app (founder print 13/10). WhatsApp: avatar + name.
    private let placeholder = UIView()
    private let phAvatar = UIImageView()
    private let phInitial = UILabel()
    private let phName = UILabel()
    private(set) var isPlaceholderVisible = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        // Fill like WhatsApp's call PiP; the window aspect is matched to the
        // video via preferredContentSize so cropping is minimal.
        displayLayer.videoGravity = .resizeAspectFill
        displayLayer.backgroundColor = UIColor.black.cgColor
        layer.addSublayer(displayLayer)

        placeholder.backgroundColor = UIColor(red: 0x1F/255.0, green: 0x2C/255.0, blue: 0x34/255.0, alpha: 1.0)
        placeholder.isHidden = true
        placeholder.isUserInteractionEnabled = false
        phAvatar.contentMode = .scaleAspectFill
        phAvatar.clipsToBounds = true
        phAvatar.backgroundColor = UIColor(red: 0x37/255.0, green: 0x4A/255.0, blue: 0x55/255.0, alpha: 1.0)
        phInitial.textColor = .white
        phInitial.textAlignment = .center
        phInitial.adjustsFontSizeToFitWidth = true
        phName.textColor = .white
        phName.textAlignment = .center
        phName.font = .systemFont(ofSize: 15, weight: .semibold)
        phName.adjustsFontSizeToFitWidth = true
        phName.minimumScaleFactor = 0.6
        placeholder.addSubview(phAvatar)
        placeholder.addSubview(phInitial)
        placeholder.addSubview(phName)
        addSubview(placeholder)
    }

    /// Main thread only. Shows/hides the avatar card over the video. Showing it
    /// also drops the frozen last frame from the display layer.
    func setPlaceholder(visible: Bool, name: String, image: UIImage?) {
        phName.text = name
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        phInitial.text = trimmed.isEmpty ? "" : String(trimmed.prefix(1)).uppercased()
        phAvatar.image = image
        phInitial.isHidden = image != nil
        guard visible != isPlaceholderVisible else { return }
        isPlaceholderVisible = visible
        if visible {
            displayLayer.flushAndRemoveImage()
        }
        placeholder.isHidden = !visible
        setNeedsLayout()
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
        // [2026-10-14 pip-frozen] avatar card layout (PiP window is small).
        placeholder.frame = b
        let side = max(24, min(b.width, b.height) * 0.42)
        let nameH: CGFloat = 22
        let top = max(0, (b.height - side - 8 - nameH) / 2)
        phAvatar.frame = CGRect(x: (b.width - side) / 2, y: top, width: side, height: side)
        phAvatar.layer.cornerRadius = side / 2
        phInitial.frame = phAvatar.frame
        phInitial.font = .systemFont(ofSize: side * 0.42, weight: .semibold)
        phName.frame = CGRect(x: 8, y: phAvatar.frame.maxY + 8, width: max(0, b.width - 16), height: nameH)
        phName.isHidden = b.height < side + 8 + nameH
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
    /// [2026-10-14 pip-frozen] CACurrentMediaTime() of the last frame handed to
    /// us (any thread; a torn/stale read only delays the stall check one tick).
    private(set) var lastFrameAt: CFTimeInterval = 0

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
        lastFrameAt = CACurrentMediaTime()

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
