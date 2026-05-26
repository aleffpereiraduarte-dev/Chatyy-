// StatusVisionCamera — single-session AR camera for Chatyy Status.
//
// SINGLE SESSION (Instagram/Snap model). Replaces the broken dual-session
// architecture (expo-camera CameraView for preview/capture + a SEPARATE
// ExpoFaceLandmarker AVCaptureSession/CameraX bind that stole the front
// lens → capture froze, taken photo never appeared).
//
// Here ONE react-native-vision-camera <Camera> owns the lens. A Skia frame
// processor:
//   1. frame.render() EVERY frame (preview at 30/60fps — never blocked).
//   2. runs MLKit face detection inside runAsync(...) so inference happens
//      at its OWN low rate on a parallel runtime and NEVER blocks the
//      render loop.
//   3. stores the detected face in a worklet shared value; draws the
//      dog-ears / glasses / etc. PNG overlay using the LAST-KNOWN face
//      between inferences, with the same 0.35 lerp smoothing the old
//      FaceFilterOverlay used.
//
// Capture goes through camera.takePhoto() / startRecording() on the SAME
// session — no second session to contend with, so no freeze.
//
// The drawn Skia overlay is PREVIEW-ONLY. It is NOT burned into the saved
// photo/video — Chatyy carries the chosen preset forward as the
// `face_filter` meta key and re-applies the overlay downstream (viewer +
// composer). StatusCamera owns that meta plumbing; this component only
// renders the live preview + returns the raw capture.
//
// Exposes an imperative ref matching the old expo-camera surface so the
// large capture/record logic in StatusCamera.js barely changed:
//   ref.takePictureAsync({ quality }) -> { uri, width, height }
//   ref.recordAsync({ maxDuration, quality }) -> { uri }
//   ref.stopRecording()
import React, {
  forwardRef, useImperativeHandle, useMemo, useRef, useCallback, useEffect,
} from 'react';
import { View, StyleSheet } from 'react-native';
import {
  Camera, useCameraDevice, useSkiaFrameProcessor, runAsync,
} from 'react-native-vision-camera';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import { Skia, useImage } from '@shopify/react-native-skia';
import { useSharedValue } from 'react-native-worklets-core';
import { resolveFilterPreset } from './FaceFilters';

// Map each preset key to its bundled PNG require id. Mirrors
// FaceFilters.FACE_FILTER_PRESETS so we can hand the SkImage objects to the
// worklet. (We can't call require() inside a worklet, so the SkImages are
// created on the JS side via useImage and referenced by the processor.)
const AR_ASSETS = {
  dog_ears: require('../../assets/ar-filters/dog_ears.png'),
  cat_whiskers: require('../../assets/ar-filters/cat_whiskers.png'),
  sunglasses: require('../../assets/ar-filters/sunglasses.png'),
  heart_eyes: require('../../assets/ar-filters/heart_eyes.png'),
  party_hat: require('../../assets/ar-filters/party_hat.png'),
  vampire: require('../../assets/ar-filters/vampire_teeth.png'),
};

function StatusVisionCameraInner(
  { facing = 'front', mode = 'picture', arFilterKey = 'none', isActive = true, onError },
  ref,
) {
  const device = useCameraDevice(facing === 'front' ? 'front' : 'back');
  const camera = useRef(null);

  // MLKit face detector plugin (same session — frame-processor plugin).
  // autoMode:false is REQUIRED when drawing on the frame via Skia so the
  // landmark/bounds coords stay in raw frame-pixel space (not pre-scaled
  // to the screen). cameraFacing lets the plugin mirror correctly.
  const faceDetector = useFaceDetector({
    performanceMode: 'fast',
    landmarkMode: 'all',
    contourMode: 'none',
    classificationMode: 'none',
    autoMode: false,
    cameraFacing: facing === 'front' ? 'front' : 'back',
  });
  const { detectFaces } = faceDetector;

  // Last-known face packet (worklet shared value). Written by runAsync from
  // the detection runtime, read by the render loop. Holding the last face
  // between inferences keeps the overlay glued on while ML runs at its own
  // slower cadence.
  const sharedFace = useSharedValue(null);
  // Smoothing memory for each anchor center (worklet shared value).
  const smooth = useSharedValue({});

  // The active preset (resolved on JS side; cheap, data-only object).
  const preset = useMemo(() => resolveFilterPreset(arFilterKey), [arFilterKey]);
  const presetKey = preset?.key || 'none';

  // Load the active overlay PNG as a SkImage (null when 'none' / not ready).
  const overlayImage = useImage(presetKey !== 'none' ? AR_ASSETS[presetKey] : null);

  // Reset smoothing memory whenever the preset changes so a new filter
  // doesn't inherit the previous filter's interpolated anchors.
  //
  // [P0 2026-05-26] AR shared-value race. The Skia frame processor reads
  // `smooth.value` on the render runtime CONCURRENTLY with this JS-side clear.
  // Assigning a fresh empty `{}` mid-read could hand the worklet a half-torn
  // object (worklets-core shared values are copied across runtimes; a clear
  // landing between the worklet's read + mutate could crash or resurrect stale
  // keys). Instead we publish a SENTINEL object `{ __cleared: true }` in a
  // single atomic assignment — the worklet treats the sentinel as "no memory
  // yet" and seeds fresh on the next frame, so the clear can't race a read into
  // a corrupt state. Wrapped in try/catch so a transient shared-value access
  // error during teardown never bubbles into a fatal.
  useEffect(() => {
    try { smooth.value = { __cleared: true }; } catch {}
  }, [presetKey]);

  // ─── Skia frame processor (the single-session render + AR draw) ───
  const frameProcessor = useSkiaFrameProcessor((frame) => {
    'worklet';
    // 1) ALWAYS render the camera frame first so preview runs at full fps
    //    regardless of detection cadence. This is the line that makes the
    //    preview never freeze.
    frame.render();

    // 2) Kick face detection on the parallel async runtime. runAsync drops
    //    frames if the previous inference hasn't finished, so ML can never
    //    back-pressure the render loop. We only do this when a filter is on.
    if (presetKey !== 'none') {
      runAsync(frame, () => {
        'worklet';
        try {
          const faces = detectFaces(frame);
          sharedFace.value = (faces && faces.length > 0) ? faces[0] : null;
        } catch (e) {
          sharedFace.value = null;
        }
      });
    }

    // 3) Draw the overlay using the LAST-KNOWN face. No image / no face / no
    //    filter → nothing to draw (preview already rendered above).
    if (presetKey === 'none' || overlayImage == null) return;
    const face = sharedFace.value;
    if (face == null || face.bounds == null) return;

    const b = face.bounds; // frame-pixel space: { x, y, width, height }
    const lm = face.landmarks || {};

    // Inter-pupil distance from eye landmarks (frame px). Falls back to
    // face width * 0.45 when eyes weren't resolved this frame.
    let ipd = b.width * 0.45;
    const le = lm.LEFT_EYE, re = lm.RIGHT_EYE;
    if (le && re) {
      const dx = le.x - re.x;
      const dy = le.y - re.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) ipd = d;
    }

    // 0.35 lerp smoothing on the anchor center (matches the old overlay's
    // low-pass filter — erases MLKit's per-frame jitter).
    const ALPHA = 0.35;
    const smoothCenter = (key, tx, ty) => {
      'worklet';
      const raw = smooth.value;
      // [P0 2026-05-26] Sentinel handling — when the JS side cleared the
      // smoothing memory on a preset change it published `{ __cleared: true }`.
      // Treat that (and a null/undefined value) as "no memory yet": start from
      // a fresh empty map so we don't carry a `__cleared` key forward or read a
      // stale anchor from the previous filter. No `prev` → no lerp, just seed.
      const cleared = raw == null || raw.__cleared === true;
      const mem = cleared ? {} : raw;
      const prev = cleared ? null : mem[key];
      let nx = tx, ny = ty;
      if (prev) {
        nx = prev.x + (tx - prev.x) * ALPHA;
        ny = prev.y + (ty - prev.y) * ALPHA;
      }
      // Reassign whole object so the shared value commit is observed. Always
      // publish the working `mem` (never the sentinel) so the next read sees a
      // real anchor map rather than the cleared marker.
      mem[key] = { x: nx, y: ny };
      smooth.value = mem;
      return { x: nx, y: ny };
    };

    // Helper to draw the overlay PNG centered at (cx,cy) sized to `size`,
    // with an optional bottom-anchor and vertical offset (size-relative).
    const iw = overlayImage.width();
    const ih = overlayImage.height();
    const srcRect = Skia.XYWHRect(0, 0, iw, ih);
    const paint = Skia.Paint();
    const drawAt = (cx, cy, size, anchorBottom, offY) => {
      'worklet';
      const w = size;
      const h = size;
      let top = cy - h / 2 + (offY || 0) * size;
      if (anchorBottom) top = cy - h + (offY || 0) * size;
      const left = cx - w / 2;
      const destRect = Skia.XYWHRect(left, top, w, h);
      frame.drawImageRect(overlayImage, srcRect, destRect, paint);
    };

    // Anchor presets (frame-pixel space). Eyes/nose/forehead derived from
    // MLKit landmarks; forehead approximated above the eye line because
    // MLKit has no forehead landmark (used for ears / party hat).
    const noseX = lm.NOSE_BASE ? lm.NOSE_BASE.x : b.x + b.width / 2;
    const noseY = lm.NOSE_BASE ? lm.NOSE_BASE.y : b.y + b.height / 2;
    const eyeMidX = (le && re) ? (le.x + re.x) / 2 : b.x + b.width / 2;
    const eyeMidY = (le && re) ? (le.y + re.y) / 2 : b.y + b.height * 0.4;
    // Forehead ≈ eye-line shifted up by ~0.9 * IPD.
    const foreX = eyeMidX;
    const foreY = eyeMidY - ipd * 0.9;
    const mouthX = lm.MOUTH_BOTTOM ? lm.MOUTH_BOTTOM.x
      : ((lm.MOUTH_LEFT && lm.MOUTH_RIGHT) ? (lm.MOUTH_LEFT.x + lm.MOUTH_RIGHT.x) / 2 : noseX);
    const mouthY = lm.MOUTH_BOTTOM ? lm.MOUTH_BOTTOM.y : noseY + ipd * 0.8;

    if (presetKey === 'dog_ears') {
      const c = smoothCenter('dog', foreX, foreY);
      drawAt(c.x, c.y, ipd * 4.0, true, -0.2);
    } else if (presetKey === 'cat_whiskers') {
      const c = smoothCenter('cat', noseX, noseY);
      drawAt(c.x, c.y, ipd * 4.2, false, 0);
    } else if (presetKey === 'sunglasses') {
      const c = smoothCenter('glasses', eyeMidX, eyeMidY);
      drawAt(c.x, c.y, ipd * 2.6, false, 0);
    } else if (presetKey === 'heart_eyes') {
      if (le) { const cl = smoothCenter('heartL', le.x, le.y); drawAt(cl.x, cl.y, ipd * 1.1, false, 0); }
      if (re) { const cr = smoothCenter('heartR', re.x, re.y); drawAt(cr.x, cr.y, ipd * 1.1, false, 0); }
    } else if (presetKey === 'party_hat') {
      const c = smoothCenter('hat', foreX, foreY);
      drawAt(c.x, c.y, ipd * 3.0, true, -0.4);
    } else if (presetKey === 'vampire') {
      const c = smoothCenter('vamp', mouthX, mouthY);
      drawAt(c.x, c.y, ipd * 2.4, false, 0.15);
    }
  }, [presetKey, overlayImage, detectFaces]);

  // ─── Imperative API (matches the old expo-camera CameraView ref) ───
  const recordingResolveRef = useRef(null);

  const takePictureAsync = useCallback(async () => {
    if (!camera.current) throw new Error('camera-not-ready');
    const photo = await camera.current.takePhoto({
      flash: 'off',
      enableShutterSound: false,
    });
    if (!photo || !photo.path) return null;
    // VisionCamera returns a bare filesystem path; downstream (ImageManipulator,
    // upload) expect a file:// URI. Normalize.
    const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
    return { uri, width: photo.width, height: photo.height };
  }, []);

  const recordAsync = useCallback(({ maxDuration } = {}) => {
    if (!camera.current) return Promise.reject(new Error('camera-not-ready'));
    return new Promise((resolve, reject) => {
      recordingResolveRef.current = resolve;
      try {
        camera.current.startRecording({
          onRecordingFinished: (video) => {
            recordingResolveRef.current = null;
            const path = video?.path || '';
            const uri = path
              ? (path.startsWith('file://') ? path : `file://${path}`)
              : null;
            resolve(uri ? { uri } : null);
          },
          onRecordingError: (err) => {
            recordingResolveRef.current = null;
            reject(err);
          },
        });
        // Honor the caller's maxDuration (expo-camera passed seconds).
        if (maxDuration && maxDuration > 0) {
          setTimeout(() => {
            try { camera.current?.stopRecording?.(); } catch {}
          }, maxDuration * 1000);
        }
      } catch (e) {
        recordingResolveRef.current = null;
        reject(e);
      }
    });
  }, []);

  const stopRecording = useCallback(() => {
    try { camera.current?.stopRecording?.(); } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    takePictureAsync,
    recordAsync,
    stopRecording,
  }), [takePictureAsync, recordAsync, stopRecording]);

  if (!device) {
    // No camera device yet (cold mount / simulator without a front lens).
    return <View style={StyleSheet.absoluteFill} />;
  }

  return (
    <Camera
      ref={camera}
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={isActive}
      photo={true}
      video={mode === 'video'}
      audio={mode === 'video'}
      frameProcessor={frameProcessor}
      onError={(e) => { try { onError?.(e); } catch {} }}
    />
  );
}

export default forwardRef(StatusVisionCameraInner);
