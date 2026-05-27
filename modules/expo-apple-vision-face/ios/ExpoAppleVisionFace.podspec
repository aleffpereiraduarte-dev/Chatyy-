require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoAppleVisionFace'
  s.version        = package['version']
  s.summary        = 'Apple Vision face detection as a VisionCamera frame-processor plugin (detectFacesVision)'
  s.description    = package['description']
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  # ExpoModulesCore so this counts as a real Expo local module and is picked up
  # by `expo prebuild` autolinking (same as modules/expo-callkit).
  s.dependency 'ExpoModulesCore'

  # VisionCamera supplies the FrameProcessorPlugin base class + Frame /
  # FrameProcessorPluginRegistry headers we subclass + register against. Pinned
  # implicitly to the app's react-native-vision-camera (4.7.x).
  s.dependency 'VisionCamera'

  # Apple Vision (VNDetectFaceLandmarksRequest) + CoreMedia for the frame's
  # CMSampleBuffer. All system frameworks — zero third-party C++, so NO protobuf
  # / GTMSessionFetcher collision with MediaPipeTasksVision (the call-blur pod).
  s.frameworks = 'Vision', 'CoreMedia', 'CoreImage', 'UIKit'

  s.source_files = '*.{h,m,mm,swift}'

  # No SWIFT_OBJC_BRIDGING_HEADER: the Swift plugin gets VisionCamera's types
  # via `import VisionCamera` (module map), and the Obj-C registration shim
  # (AppleVisionFaceDetector.m) imports them via `#import <VisionCamera/...>` and
  # the generated `ExpoAppleVisionFace-Swift.h`. CocoaPods auto-defines the pod
  # module + emits the -Swift.h header — this mirrors EXACTLY how
  # react-native-vision-camera-face-detector wires its plugin under CocoaPods
  # (its podspec sets no bridging-header xcconfig either).
end
