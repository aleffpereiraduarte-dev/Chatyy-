// SkiaFaceCamera — the single-camera AR engine for the status composer.
//
// ONE react-native-vision-camera feed. A useSkiaFrameProcessor worklet runs
// the MLKit face detector on each frame, then draws the selected AR effect
// (dog ears / glasses / hearts / …) straight into the frame's Skia canvas
// and calls frame.render(). The composited frame is BOTH the live preview and
// the source for capture (takeSnapshot) — there is no second camera session,
// so the old MediaPipe "status com efeito travando" freeze cannot happen.
//
// FILTER-SWITCH CRASH GUARD (VisionCamera v4 + Skia frameProcessor recreate,
// issue #3606): the frame processor function is created ONCE. The active
// effect is held in a Skia `useSharedValue` (a *mutable value*, not React
// state). Changing the filter only mutates `effectSV.value` — the worklet
// reads it each frame. We never pass a fresh frameProcessor on filter change,
// so the native side never tears down + recreates the processor (the crash
// path). The dependency array of useSkiaFrameProcessor is therefore EMPTY.
//
// Everything native is imported at module load behind a try/catch via the
// lazy loader in StatusCamera; this file is only imported when the bindings
// are known to exist (native build). On web / missing-binding it is never
// reached (StatusCamera falls back to expo-camera CameraView).
//
// Exposed imperatively via ref:
//   capture() → Promise<{ uri, width, height }>  (composited snapshot)

import React, { forwardRef, useImperativeHandle, useMemo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useSkiaFrameProcessor,
} from 'react-native-vision-camera';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import { useSharedValue } from 'react-native-worklets-core';
import { drawEffect } from './SkiaFaceEffects';

const SkiaFaceCamera = forwardRef(function SkiaFaceCamera(
  { facing = 'front', effectId = 0, isActive = true, photo = true, video = true, audio = false, torch = 'off' },
  ref
) {
  const cameraRef = React.useRef(null);
  const device = useCameraDevice(facing === 'front' ? 'front' : 'back');

  // Mutable value the worklet reads each frame. Mutating .value does NOT
  // recreate the frame processor — that's the whole point of the crash guard.
  const effectSV = useSharedValue(effectId);
  React.useEffect(() => {
    effectSV.value = effectId;
  }, [effectId]);

  // MLKit face detector — landmarks ON so we get eye/nose/mouth positions,
  // 'fast' mode so the worklet stays at frame rate. contourMode off to keep
  // the per-frame cost low (we don't draw contours).
  const faceDetectionOptions = useMemo(() => ({
    performanceMode: 'fast',
    landmarkMode: 'all',
    contourMode: 'none',
    classificationMode: 'none',
    minFaceSize: 0.15,
    trackingEnabled: true,
  }), []);
  const { detectFaces } = useFaceDetector(faceDetectionOptions);

  // The ONE frame processor. Created once (empty deps). Reads effectSV.value
  // and the live faces every frame, composites the effect into the canvas.
  const frameProcessor = useSkiaFrameProcessor((frame) => {
    'worklet';
    // 1) Render the raw camera frame first (this is the base layer).
    frame.render();
    const id = effectSV.value;
    if (!id) return; // 'none' selected — just the raw preview, nothing to draw.
    // 2) Detect faces on this frame.
    let faces;
    try {
      faces = detectFaces(frame);
    } catch (e) {
      return; // detector hiccup — skip the overlay this frame, never crash.
    }
    if (!faces || !faces.length) return;
    // 3) Draw the selected effect over each detected face into the frame's
    //    Skia canvas. frame IS a SkCanvas in useSkiaFrameProcessor.
    for (let i = 0; i < faces.length; i++) {
      drawEffect(frame, faces[i], id);
    }
  }, []);

  // Imperative capture — snapshots the COMPOSITED preview (effect burned in)
  // so the published status photo includes the drawn filter. Falls back to
  // takePhoto() when takeSnapshot isn't available on the device.
  useImperativeHandle(ref, () => ({
    async capture() {
      const cam = cameraRef.current;
      if (!cam) throw new Error('camera-not-ready');
      // takeSnapshot grabs the rendered (Skia-composited) preview surface,
      // which already has the effect drawn in by the frame processor.
      if (typeof cam.takeSnapshot === 'function') {
        try {
          const snap = await cam.takeSnapshot({ quality: 92 });
          return {
            uri: snap.path?.startsWith('file://') ? snap.path : `file://${snap.path}`,
            width: snap.width,
            height: snap.height,
          };
        } catch (e) {
          // fall through to takePhoto
        }
      }
      const p = await cam.takePhoto({ qualityPrioritization: 'balanced' });
      return {
        uri: p.path?.startsWith('file://') ? p.path : `file://${p.path}`,
        width: p.width,
        height: p.height,
      };
    },
    async startRecording(opts) {
      const cam = cameraRef.current;
      if (!cam) throw new Error('camera-not-ready');
      return cam.startRecording(opts);
    },
    async stopRecording() {
      const cam = cameraRef.current;
      if (!cam) return;
      return cam.stopRecording();
    },
    getDevice: () => device,
  }), [device]);

  if (!device) return null;

  return (
    <Camera
      ref={cameraRef}
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={isActive}
      photo={photo}
      video={video}
      audio={audio}
      torch={torch}
      frameProcessor={frameProcessor}
      // Mirror the front camera preview so the AR overlay tracks what the
      // user sees (Vision Camera does not mirror the snapshot, matching the
      // existing front-cam flip handling in StatusCamera).
      isMirrored={facing === 'front'}
    />
  );
});

export default SkiaFaceCamera;
