// react-native.config.js — RN autolinking overrides.
//
// [2026-05-26 "one ML stack per platform"] Disable
// react-native-vision-camera-face-detector on iOS ONLY.
//
// Why: that package vendors GoogleMLKit/FaceDetection (8.0.0) on iOS, which
// statically embeds an INCOMPATIBLE protobuf (`proto2::` namespace) alongside
// its own GTMSessionFetcher / GoogleToolboxForMac copies. The call-screen
// background blur (MediaPipeTasksVision, via
// modules/expo-callkit/ios/ExpoCallKit.podspec) statically embeds the OTHER
// protobuf (`google::protobuf`) plus its own copies of the same support libs.
// The two cannot coexist in one iOS binary — the linker aborts with ~221
// `ld: duplicate symbol` errors, and `ar -d` stripping only trades them for
// undefined symbols. Both features are required.
//
// The durable fix: NO MLKit on iOS. iOS does Status AR face detection with
// Apple Vision (`VNDetectFaceLandmarksRequest`, system framework, zero C++,
// no protobuf, no collision) via the local `expo-apple-vision-face` module's
// `detectFacesVision` VisionCamera frame-processor plugin. MediaPipe keeps the
// blur on iOS untouched. MLKit stays on ANDROID (face-detector autolinks there
// normally — Android has no MediaPipe-vs-MLKit link collision).
//
// Setting `platforms.ios = null` stops RN/Expo autolinking from adding the
// VisionCameraFaceDetector pod (and thus GoogleMLKit) to the iOS Podfile,
// while leaving the Android Gradle autolink intact.
module.exports = {
  dependencies: {
    'react-native-vision-camera-face-detector': {
      platforms: {
        ios: null,
      },
    },
  },
};
