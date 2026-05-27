// faceDetectorShim — one ML stack per platform for Status AR face detection.
//
// [2026-05-26] The Skia overlay in StatusVisionCamera.js needs a worklet-
// callable `detectFaces(frame) -> Face[]`. The Face shape (bounds + named
// landmarks in the oriented, front-mirrored frame-pixel space) is identical on
// both platforms, but the engine behind it differs:
//
//   Android → react-native-vision-camera-face-detector (GoogleMLKit), the
//             `detectFaces` VisionCamera frame-processor plugin, via
//             useFaceDetector(). MLKit on Android has no link collision.
//
//   iOS     → Apple Vision (VNDetectFaceLandmarksRequest), the
//             `detectFacesVision` VisionCamera frame-processor plugin shipped by
//             the local modules/expo-apple-vision-face module. MLKit is REMOVED
//             from iOS (react-native.config.js) because GoogleMLKit's protobuf
//             collides with MediaPipe's call-blur at link time.
//
// CRITICAL: never import react-native-vision-camera-face-detector's
// useFaceDetector on iOS, and never call it conditionally inside the component
// (hook-order). This hook ALWAYS runs the same number of hooks on a given
// platform — the platform is fixed for the process lifetime, so the branch is
// stable across renders. On iOS we initialize the Apple Vision plugin via
// VisionCameraProxy (the exact mechanism the MLKit wrapper uses internally) and
// expose a `detectFaces` worklet that calls plugin.call(frame).

import { Platform } from 'react-native';
import { useMemo } from 'react';
import { VisionCameraProxy } from 'react-native-vision-camera';

// Android-only require, kept lazy so the iOS bundle never pulls the MLKit
// wrapper module (whose native plugin `detectFaces` does not exist on iOS).
let _useFaceDetectorAndroid = null;
if (Platform.OS === 'android') {
  // eslint-disable-next-line global-require
  _useFaceDetectorAndroid = require('react-native-vision-camera-face-detector').useFaceDetector;
}

// Initialize the Apple Vision frame-processor plugin once (iOS only). Mirrors
// react-native-vision-camera-face-detector's createFaceDetectorPlugin: grab the
// plugin from the proxy, then expose a worklet that calls it. We forward the
// same options the JS passes (cameraFacing etc.) so the native side can mirror
// orientation the way MLKit does.
function createAppleVisionDetector(options) {
  const plugin = VisionCameraProxy.initFrameProcessorPlugin('detectFacesVision', {
    ...options,
  });

  if (!plugin) {
    throw new Error('Failed to load Frame Processor Plugin "detectFacesVision"!');
  }

  return {
    detectFaces: (frame) => {
      'worklet';
      // @ts-ignore — plugin.call returns the Face[] dict array built natively.
      return plugin.call(frame);
    },
    // No-op to match the MLKit detector surface (stopListeners is Android-only
    // in the upstream lib anyway).
    stopListeners: () => {},
  };
}

// useFaceDetectorShim — same signature/return as the MLKit useFaceDetector:
//   { detectFaces, stopListeners }
// On Android delegates to the real MLKit hook; on iOS builds the Apple Vision
// plugin. Memoized on the options object exactly like the upstream hook so the
// plugin instance is stable across renders.
export function useFaceDetectorShim(options) {
  if (Platform.OS === 'android') {
    // Android: real MLKit detector. Same hook the component used before.
    return _useFaceDetectorAndroid(options);
  }
  // iOS (and any non-Android native): Apple Vision detector.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useMemo(() => createAppleVisionDetector(options), [options]);
}
