// AppleVisionFaceDetector.swift — iOS Status AR face detection via Apple Vision.
//
// [2026-05-26 "one ML stack per platform"] This is the iOS replacement for
// react-native-vision-camera-face-detector's MLKit `detectFaces` plugin, which
// we removed from iOS because GoogleMLKit's protobuf collides at link time with
// MediaPipe's blur (see react-native.config.js). Android keeps MLKit; iOS uses
// Apple Vision (VNDetectFaceLandmarksRequest) — a system framework with zero
// third-party C++, so no duplicate-symbol collision.
//
// It registers (via AppleVisionFaceDetector.m) as a VisionCamera frame-
// processor plugin named `detectFacesVision`, invoked from the Skia frame-
// processor worklet in components/status/StatusVisionCamera.js.
//
// ── Output contract (MUST match MLKit so the JS overlay is unchanged) ──
// The plugin returns an array of face dicts shaped EXACTLY like the MLKit
// `Face` objects the JS consumes when `useFaceDetector({ autoMode: false })`:
//
//   {
//     bounds:    { x, y, width, height }   // top-left origin, frame-pixel space
//     landmarks: { LEFT_EYE, RIGHT_EYE, NOSE_BASE,
//                  MOUTH_LEFT, MOUTH_RIGHT, MOUTH_BOTTOM, ... : { x, y } }
//     pitchAngle, rollAngle, yawAngle: Double
//   }
//
// Coordinate space — the part that has to be byte-for-byte right:
//   The JS draws inside a Skia frame processor with autoMode:false. In that
//   mode the MLKit plugin returns coords in the frame's ORIENTED drawing space:
//   an upright, FRONT-MIRRORED image whose dimensions are
//   `width = frame.height`, `height = frame.width` (MLKit inverts because the
//   sensor buffer is 90deg-rotated), top-left origin. `frame.render()` paints
//   that same oriented/mirrored image, so overlay coords land on the face.
//
//   We reproduce it by handing Vision the SAME orientation MLKit feeds its
//   VisionImage for a front-camera portrait frame (`.leftMirrored`), then
//   converting Vision's normalized, bottom-left-origin output into top-left
//   pixel coords over those same oriented dimensions:
//     - landmarks: `region.pointsInImage(imageSize:)` already returns oriented
//       pixel points, but with a BOTTOM-LEFT origin → flip Y.
//     - bounds: `VNImageRectForNormalizedRect` likewise → flip Y.
//
//   We mirror MLKit's orientation table (getImageOrientation) so back-camera
//   and device-rotation cases line up too, driven by the `cameraFacing` option
//   the JS passes and the live interface orientation.

// `import VisionCamera` brings in the Swift-visible Frame / FrameProcessorPlugin
// / VisionCameraProxyHolder types (exposed through VisionCamera's module map),
// exactly as react-native-vision-camera-face-detector's Swift does. This is the
// proven path — no per-pod bridging header needed for the Swift side.
import VisionCamera
import Foundation
import Vision
import CoreMedia
import CoreImage
import UIKit
import AVFoundation

@objc(AppleVisionFaceDetector)
public class AppleVisionFaceDetector: FrameProcessorPlugin {
  private var cameraFacing: AVCaptureDevice.Position = .front

  public override init(
    proxy: VisionCameraProxyHolder,
    options: [AnyHashable: Any]? = [:]
  ) {
    super.init(proxy: proxy, options: options)
    if let facing = options?["cameraFacing"] as? String, facing == "back" {
      cameraFacing = .back
    }
  }

  // Mirror MLKit's getImageOrientation() (VisionCameraFaceDetector.swift) so
  // the oriented image space — and thus every returned coordinate — matches the
  // Android/iOS-MLKit path 1:1. Returns a CGImagePropertyOrientation (what
  // VNImageRequestHandler wants) equivalent to MLKit's UIImage.Orientation.
  private func cgOrientation() -> CGImagePropertyOrientation {
    // Read the live interface orientation on the main actor-free path. The
    // frame processor runs off the main thread, so we read the cached app
    // orientation defensively; portrait is the overwhelmingly common Status
    // case and the safe default.
    let interfaceOrientation = Self.currentInterfaceOrientation()
    switch interfaceOrientation {
    case .portrait:
      return cameraFacing == .front ? .leftMirrored : .right
    case .landscapeLeft:
      return cameraFacing == .front ? .upMirrored : .up
    case .portraitUpsideDown:
      return cameraFacing == .front ? .rightMirrored : .left
    case .landscapeRight:
      return cameraFacing == .front ? .downMirrored : .down
    default:
      return cameraFacing == .front ? .leftMirrored : .right
    }
  }

  // Best-effort current interface orientation, readable from any thread without
  // touching UIApplication on a background thread (which is disallowed). We
  // snapshot it on the main thread and cache. Portrait fallback keeps Status —
  // which is portrait-locked in practice — correct even if the snapshot is stale.
  private static var cachedOrientation: UIInterfaceOrientation = .portrait
  private static func currentInterfaceOrientation() -> UIInterfaceOrientation {
    if Thread.isMainThread {
      cachedOrientation = activeInterfaceOrientation() ?? cachedOrientation
    } else {
      DispatchQueue.main.async {
        cachedOrientation = activeInterfaceOrientation() ?? cachedOrientation
      }
    }
    return cachedOrientation
  }

  private static func activeInterfaceOrientation() -> UIInterfaceOrientation? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
      ?? UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first
    return scene?.interfaceOrientation
  }

  public override func callback(
    _ frame: Frame,
    withArguments arguments: [AnyHashable: Any]?
  ) -> Any? {
    guard CMSampleBufferIsValid(frame.buffer) else { return [] }

    let orientation = cgOrientation()

    // Oriented drawing dimensions, matching MLKit: the sensor buffer is
    // 90deg-rotated, so the upright image is frame.height wide x frame.width
    // tall. Every returned coordinate is expressed in THIS space.
    let orientedWidth = CGFloat(frame.height)
    let orientedHeight = CGFloat(frame.width)

    let request = VNDetectFaceLandmarksRequest()
    // Vision's revision affects landmark counts; keep the default (latest)
    // which exposes leftEye/rightEye/nose/outerLips etc. as point regions.

    let handler = VNImageRequestHandler(
      cmSampleBuffer: frame.buffer,
      orientation: orientation,
      options: [:]
    )

    do {
      try handler.perform([request])
    } catch {
      return []
    }

    guard let observations = request.results, !observations.isEmpty else {
      return []
    }

    var result: [Any] = []
    for face in observations {
      result.append(
        mapFace(face, orientedWidth: orientedWidth, orientedHeight: orientedHeight)
      )
    }
    return result
  }

  // Convert one VNFaceObservation into the MLKit-shaped dict.
  private func mapFace(
    _ face: VNFaceObservation,
    orientedWidth: CGFloat,
    orientedHeight: CGFloat
  ) -> [String: Any] {
    var map: [String: Any] = [:]

    // ── bounds ── Vision boundingBox is normalized [0..1], bottom-left origin,
    // in the oriented image space. Convert to oriented pixels, then flip Y to a
    // top-left origin so it matches MLKit's bounds.
    let pixelRect = VNImageRectForNormalizedRect(
      face.boundingBox,
      Int(orientedWidth),
      Int(orientedHeight)
    )
    let boundsX = pixelRect.origin.x
    let boundsY = orientedHeight - (pixelRect.origin.y + pixelRect.height)
    map["bounds"] = [
      "x": boundsX,
      "y": boundsY,
      "width": pixelRect.width,
      "height": pixelRect.height,
    ]

    // ── angles ── Vision exposes roll + yaw (radians) and, on newer revisions,
    // pitch. Convert to degrees to match MLKit's Euler angles (the JS only
    // reads bounds + landmarks today, but we keep the field shape complete).
    let rad2deg = 180.0 / Double.pi
    map["rollAngle"] = (face.roll?.doubleValue ?? 0) * rad2deg
    map["yawAngle"] = (face.yaw?.doubleValue ?? 0) * rad2deg
    if #available(iOS 15.0, *) {
      map["pitchAngle"] = (face.pitch?.doubleValue ?? 0) * rad2deg
    } else {
      map["pitchAngle"] = 0.0
    }

    // ── landmarks ── Map Vision regions to MLKit's named single points. The JS
    // (StatusVisionCamera.js) reads: LEFT_EYE, RIGHT_EYE, NOSE_BASE,
    // MOUTH_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT. We also fill the remaining MLKit
    // landmark names (cheeks/ears) with sensible derivations so the shape is
    // complete and forward-compatible.
    if let landmarks = face.landmarks {
      var lm: [String: [String: CGFloat]] = [:]

      // pointsInImage(imageSize:) returns region points in oriented IMAGE
      // pixels with a BOTTOM-LEFT origin → flip Y per point to top-left.
      func centroid(_ region: VNFaceLandmarkRegion2D?) -> CGPoint? {
        guard let region = region, region.pointCount > 0 else { return nil }
        let pts = region.pointsInImage(
          imageSize: CGSize(width: orientedWidth, height: orientedHeight)
        )
        var sx: CGFloat = 0, sy: CGFloat = 0
        for p in pts { sx += p.x; sy += p.y }
        let n = CGFloat(pts.count)
        return CGPoint(x: sx / n, y: orientedHeight - (sy / n))
      }

      // Extreme-x point of a region (already Y-flipped), for mouth corners.
      // wantMin=true → smallest x (image-left); false → largest x (image-right).
      func extremeX(_ region: VNFaceLandmarkRegion2D?, wantMin: Bool) -> CGPoint? {
        guard let region = region, region.pointCount > 0 else { return nil }
        let pts = region.pointsInImage(
          imageSize: CGSize(width: orientedWidth, height: orientedHeight)
        )
        var best = pts[0]
        for p in pts {
          if (wantMin && p.x < best.x) || (!wantMin && p.x > best.x) { best = p }
        }
        return CGPoint(x: best.x, y: orientedHeight - best.y)
      }

      // Lowest point of a region (max image-Y = bottom of mouth), Y-flipped.
      func bottomMost(_ region: VNFaceLandmarkRegion2D?) -> CGPoint? {
        guard let region = region, region.pointCount > 0 else { return nil }
        let pts = region.pointsInImage(
          imageSize: CGSize(width: orientedWidth, height: orientedHeight)
        )
        var best = pts[0]
        for p in pts { if p.y < best.y { best = p } } // smallest bottom-left-Y = visually lowest
        return CGPoint(x: best.x, y: orientedHeight - best.y)
      }

      func put(_ key: String, _ pt: CGPoint?) {
        guard let pt = pt else { return }
        lm[key] = ["x": pt.x, "y": pt.y]
      }

      let leftEye = centroid(landmarks.leftEye)
      let rightEye = centroid(landmarks.rightEye)
      put("LEFT_EYE", leftEye)
      put("RIGHT_EYE", rightEye)

      // Nose: Vision `nose` region is the bridge/tip line; its centroid is a
      // good stand-in for MLKit's NOSE_BASE (nose root/base).
      put("NOSE_BASE", centroid(landmarks.nose))

      // Mouth: derive MLKit's named mouth points from Vision's outerLips ring.
      let lips = landmarks.outerLips
      put("MOUTH_BOTTOM", bottomMost(lips))
      put("MOUTH_LEFT", extremeX(lips, wantMin: true))
      put("MOUTH_RIGHT", extremeX(lips, wantMin: false))

      // Cheeks/ears aren't first-class Vision regions; approximate from the eye
      // line + bounds so the MLKit landmark set is complete. The JS doesn't read
      // these today, but matching the full shape keeps the contract honest.
      if let le = leftEye, let re = rightEye {
        let eyeMidY = (le.y + re.y) / 2
        put("LEFT_CHEEK", CGPoint(x: le.x, y: eyeMidY + pixelRect.height * 0.25))
        put("RIGHT_CHEEK", CGPoint(x: re.x, y: eyeMidY + pixelRect.height * 0.25))
        put("LEFT_EAR", CGPoint(x: boundsX, y: eyeMidY))
        put("RIGHT_EAR", CGPoint(x: boundsX + pixelRect.width, y: eyeMidY))
      }

      map["landmarks"] = lm
    }

    return map
  }
}
