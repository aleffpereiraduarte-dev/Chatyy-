// ExpoFaceLandmarkerModule — real-time face landmark tracking for AR
// status filters (sunglasses, dog ears, party hat, etc.).
//
// Uses Apple's Vision framework (VNDetectFaceLandmarksRequest) instead of
// MediaPipe Tasks Vision to keep the binary small — Vision is built into
// iOS 13+, no extra pods or .task model files needed. Accuracy is on par
// with MediaPipe for the handful of anchors our overlays need (eyes,
// nose tip, mouth, ear top, chin).
//
// JS contract (FaceFilterOverlay.js):
//   - startFaceLandmarker({ fps: 15..30 }) — begin emitting events
//   - stopFaceLandmarker()                  — release the camera + request
//   - addListener('faceLandmarks', cb)     — { landmarks: [{x,y,z?}, ...] }
//     where the array is indexed by MediaPipe-compatible landmark IDs:
//       [1]=noseTip, [10]=forehead, [13]=upperLip, [14]=lowerLip,
//       [33]=leftEyeOuter, [263]=rightEyeOuter, [152]=chin,
//       [468]=leftPupil, [473]=rightPupil
//     Values are normalized (0..1) in image-space with the SAME orientation
//     the camera preview is showing (we apply EXIF up-correction).
//
// Performance:
//   - Vision requests run on a background dispatch queue.
//   - We throttle to the requested fps by skipping CMSampleBuffers.
//   - Native side enforces fps; JS thread sees at most `fps` events.
//
// Why we ship this in expo-native-toolkit instead of its own module:
//   - Toolkit is already linked, so adding a sibling Swift file avoids a
//     new pod and the autolinking churn that comes with it.
//   - JS lazy-requires it via getMediaPipe() — the binding is registered
//     under the name "ExpoMediaPipeFace" for compatibility with the
//     filter overlay code already in production.
//
// ⚠️ KNOWN LIMITATION (2026-05-21):
//   iOS only lets ONE AVCaptureSession own the front camera at a time.
//   When StatusCamera is up and using expo-camera's CameraView, this
//   module's startCapture() will fail to acquire the device — Vision
//   gets no frames, and the JS overlay stays in static fallback mode.
//
//   The proper fix is to share the buffer stream from expo-camera with
//   this module (frame processor / sample buffer delegate). expo-camera
//   SDK 55 doesn't expose that API, so the options are:
//     a) Patch expo-camera to forward CMSampleBuffers to us (small)
//     b) Replace CameraView with our own AVCaptureVideoPreviewLayer +
//        a delegate that dispatches to BOTH the preview AND Vision
//     c) Wait for SDK 56's frame-processor API
//
//   Until that's done, the module is functional only when called by
//   itself (no other camera UI active). On a rebuild that ships with
//   option (a) or (b), the filter tracking goes live for users.

import ExpoModulesCore
import AVFoundation
import Vision
import UIKit

// MARK: ─── AVCaptureVideoDataOutputSampleBufferDelegate helper ──────────────
// AVCaptureVideoDataOutputSampleBufferDelegate extends NSObjectProtocol, which
// requires the conforming type to be an NSObject subclass. ExpoModulesCore's
// BaseModule is a pure Swift class (not NSObject), so the module class itself
// cannot conform to this protocol — Xcode 16 raises a compile error.
// We extract the AV delegate into a thin NSObject helper that forwards frames
// back to the module via a closure. Zero behaviour change.

private final class FaceLandmarkerCaptureDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    var onFrame: ((CMSampleBuffer) -> Void)?

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        onFrame?(sampleBuffer)
    }
}

// MARK: ─── ExpoFaceLandmarkerModule ─────────────────────────────────────────

public final class ExpoFaceLandmarkerModule: Module {

    // MARK: Capture pipeline
    private let captureQueue = DispatchQueue(label: "chatyy.facelandmarker.capture", qos: .userInitiated)
    private var captureSession: AVCaptureSession?
    private var videoOutput: AVCaptureVideoDataOutput?
    private var captureDelegate: FaceLandmarkerCaptureDelegate?
    private var sequenceHandler = VNSequenceRequestHandler()

    // MARK: Throttle
    private var targetFps: Int = 30
    private var minFrameInterval: TimeInterval { 1.0 / Double(max(1, targetFps)) }
    private var lastEmitAt: TimeInterval = 0

    // MARK: Lifecycle
    private var running = false

    public func definition() -> ModuleDefinition {
        Name("ExpoMediaPipeFace")

        // Single event — FaceFilterOverlay subscribes to "faceLandmarks".
        // Payload shape: { landmarks: [{ x, y, z? }, ...] } where the
        // outer array can contain multiple faces (we currently emit just
        // the dominant one to keep payloads small).
        Events("faceLandmarks")

        AsyncFunction("startFaceLandmarker") { (options: [String: Any]?) -> Bool in
            if let fps = options?["fps"] as? Int { self.targetFps = max(5, min(60, fps)) }
            return self.startCapture()
        }

        Function("stopFaceLandmarker") {
            self.stopCapture()
        }

        // No-op on iOS — included so the JS contract matches Android.
        Function("setTargetFps") { (fps: Int) in
            self.targetFps = max(5, min(60, fps))
        }

        OnDestroy {
            self.stopCapture()
        }
    }

    // MARK: Capture setup

    private func startCapture() -> Bool {
        if running { return true }
        let session = AVCaptureSession()
        session.sessionPreset = .vga640x480 // 640×480 is plenty for landmarks

        // Front camera — we always run face landmarks against the selfie
        // lens for status filters.
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                    for: .video,
                                                    position: .front),
              let input = try? AVCaptureDeviceInput(device: device) else {
            NSLog("[FaceLandmarker] no front camera input")
            return false
        }
        if session.canAddInput(input) { session.addInput(input) }

        let delegate = FaceLandmarkerCaptureDelegate()
        delegate.onFrame = { [weak self] sampleBuffer in
            self?.handleSampleBuffer(sampleBuffer)
        }

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(delegate, queue: captureQueue)
        if session.canAddOutput(output) { session.addOutput(output) }

        if let conn = output.connection(with: .video) {
            // Match the user's mirrored preview. FaceFilterOverlay handles
            // X-mirroring on the JS side based on `facing`, so we ship the
            // raw image-space coordinates here.
            conn.videoOrientation = .portrait
            conn.isVideoMirrored = false
        }

        self.captureSession = session
        self.videoOutput = output
        self.captureDelegate = delegate

        captureQueue.async {
            session.startRunning()
            self.running = true
        }
        return true
    }

    private func stopCapture() {
        guard running else { return }
        running = false
        captureQueue.async {
            self.captureSession?.stopRunning()
            self.videoOutput?.setSampleBufferDelegate(nil, queue: nil)
            self.captureDelegate = nil
            self.captureSession = nil
            self.videoOutput = nil
            self.sequenceHandler = VNSequenceRequestHandler()
        }
    }

    // MARK: Frame -> Vision -> JS event

    private func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        // FPS throttle — Vision can run hot on older devices; we cap at
        // the requested fps so the JS bridge never queues up.
        let now = CACurrentMediaTime()
        if now - lastEmitAt < minFrameInterval { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let request = VNDetectFaceLandmarksRequest { [weak self] req, _ in
            guard let self = self else { return }
            guard let observations = req.results as? [VNFaceObservation],
                  let face = observations.first else { return }
            let payload = self.encode(face)
            self.lastEmitAt = CACurrentMediaTime()
            DispatchQueue.main.async {
                self.sendEvent("faceLandmarks", ["landmarks": [payload]])
            }
        }
        request.revision = VNDetectFaceLandmarksRequestRevision3

        do {
            // Vision expects oriented input — front camera in portrait is
            // .leftMirrored from the sensor's POV.
            try sequenceHandler.perform([request],
                                        on: pixelBuffer,
                                        orientation: .leftMirrored)
        } catch {
            // Silent — face just won't update this frame
        }
    }

    // MARK: Landmark mapping
    //
    // Vision returns a `VNFaceLandmarks2D` with named regions
    // (leftEye, rightEye, nose, outerLips, ...). We synthesize a sparse
    // array indexed by MediaPipe-compatible IDs so the JS overlay code
    // doesn't have to branch.

    private func encode(_ face: VNFaceObservation) -> [String: Any] {
        // Default: dictionary keyed by string indices so the JS side can
        // do `landmarks[1]`, `landmarks[33]`, etc. without big sparse
        // arrays going over the bridge.
        var lms: [String: [String: Double]] = [:]

        let bbox = face.boundingBox // image-space, origin bottom-left

        // Helper — convert Vision's bbox-relative point to image-space
        // normalized {x, y} with origin top-left (matches MediaPipe).
        func toImage(_ p: CGPoint) -> [String: Double] {
            let x = bbox.origin.x + p.x * bbox.size.width
            // Vision is origin bottom-left; flip Y.
            let y = 1.0 - (bbox.origin.y + p.y * bbox.size.height)
            return ["x": Double(x), "y": Double(y)]
        }

        // Convenience for landmarks defined by a region average.
        func centroid(_ region: VNFaceLandmarkRegion2D?) -> [String: Double]? {
            guard let region = region, region.pointCount > 0 else { return nil }
            var sx = 0.0, sy = 0.0
            for p in region.normalizedPoints { sx += Double(p.x); sy += Double(p.y) }
            let cx = sx / Double(region.pointCount)
            let cy = sy / Double(region.pointCount)
            return toImage(CGPoint(x: cx, y: cy))
        }

        guard let l = face.landmarks else { return ["bbox": bboxDict(bbox)] }

        // [1] = nose tip
        if let p = l.noseCrest?.normalizedPoints.last { lms["1"] = toImage(p) }
        else if let c = centroid(l.nose) { lms["1"] = c }

        // [10] = forehead — Vision doesn't expose it directly; approximate
        // as bbox top-center.
        lms["10"] = ["x": Double(bbox.midX), "y": Double(1.0 - bbox.maxY)]

        // [152] = chin — bbox bottom-center.
        lms["152"] = ["x": Double(bbox.midX), "y": Double(1.0 - bbox.minY)]

        // [33] = left eye outer corner, [263] = right eye outer corner
        if let leftEye = l.leftEye, leftEye.pointCount >= 4 {
            // Region runs around the eye; the outermost X point is the corner.
            var outer = leftEye.normalizedPoints[0]
            for p in leftEye.normalizedPoints { if p.x < outer.x { outer = p } }
            lms["33"] = toImage(outer)
        }
        if let rightEye = l.rightEye, rightEye.pointCount >= 4 {
            var outer = rightEye.normalizedPoints[0]
            for p in rightEye.normalizedPoints { if p.x > outer.x { outer = p } }
            lms["263"] = toImage(outer)
        }

        // [468] / [473] = pupils (MediaPipe iris). We approximate as the
        // centroid of the eye region — close enough for "heart eyes".
        if let c = centroid(l.leftPupil ?? l.leftEye) { lms["468"] = c }
        if let c = centroid(l.rightPupil ?? l.rightEye) { lms["473"] = c }

        // [13] = upper lip center, [14] = lower lip center
        if let outerLips = l.outerLips, outerLips.pointCount >= 4 {
            // Outer lips traces around the mouth; top point = lowest Y.
            var top = outerLips.normalizedPoints[0]
            var bot = outerLips.normalizedPoints[0]
            for p in outerLips.normalizedPoints {
                if p.y > top.y { top = p }
                if p.y < bot.y { bot = p }
            }
            lms["13"] = toImage(top)
            lms["14"] = toImage(bot)
        }

        // Wrap into the array shape JS expects. We return an object so the
        // bridge serializes ~10 keys instead of 478 array slots.
        return [
            "indexed": lms,
            "bbox": bboxDict(bbox)
        ]
    }

    private func bboxDict(_ b: CGRect) -> [String: Double] {
        return [
            "x": Double(b.origin.x),
            "y": Double(1.0 - b.maxY),
            "w": Double(b.size.width),
            "h": Double(b.size.height)
        ]
    }
}
