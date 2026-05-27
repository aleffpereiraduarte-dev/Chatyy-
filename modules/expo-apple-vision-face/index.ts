// expo-apple-vision-face — iOS Apple Vision face detection for Status AR.
//
// [2026-05-26 "one ML stack per platform"] iOS does Status AR face detection
// with Apple Vision instead of GoogleMLKit (which collides at link time with
// MediaPipe's blur — see react-native.config.js). This local Expo module
// ships a single native artifact: a VisionCamera frame-processor plugin named
// `detectFacesVision`, registered in
// `ios/AppleVisionFaceDetector.swift` + `ios/AppleVisionFaceDetector.m`.
//
// There is NO Expo NativeModule class here (apple.modules is empty): the
// plugin is invoked from a Skia frame-processor worklet via
// VisionCameraProxy.initFrameProcessorPlugin('detectFacesVision'), exactly the
// way react-native-vision-camera-face-detector exposes its own `detectFaces`
// plugin. The plugin returns the SAME `Face[]` shape MLKit returns (bounds +
// named landmarks in the oriented, front-mirrored frame-pixel drawing space),
// so the shared Skia overlay in components/status/StatusVisionCamera.js works
// unchanged across both platforms.
//
// This file exists so the package resolves and Expo autolinking picks up the
// podspec (which is what actually registers the frame processor). It exports
// nothing runtime-relevant; the JS side talks to the plugin through
// VisionCameraProxy, never through requireNativeModule.
//
// Android: this module is apple-only (see expo-module.config.json platforms).
// Android keeps GoogleMLKit via react-native-vision-camera-face-detector.

export const PLUGIN_NAME = 'detectFacesVision';
