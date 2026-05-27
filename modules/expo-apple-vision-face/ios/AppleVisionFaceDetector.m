// AppleVisionFaceDetector.m — registers the Swift Apple Vision plugin with
// VisionCamera under the name `detectFacesVision`.
//
// VisionCamera's frame-processor registry is an Obj-C API
// (`FrameProcessorPluginRegistry addFrameProcessorPlugin:withInitializer:`),
// and the registration must run at image load. We mirror EXACTLY the pattern
// react-native-vision-camera-face-detector uses for its `detectFaces` plugin
// (a `+load` category on the Swift class) — see
// node_modules/react-native-vision-camera-face-detector/ios/VisionCameraFaceDetector.m.
//
// The Swift class `AppleVisionFaceDetector` is exposed to Obj-C via the
// generated `ExpoAppleVisionFace-Swift.h`; under CocoaPods the generated
// header lives at `<PodName>/<PodName>-Swift.h`, so we try that first and fall
// back to the flat name (matches the face-detector's include dance).
#import <Foundation/Foundation.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/Frame.h>

#if __has_include("ExpoAppleVisionFace/ExpoAppleVisionFace-Swift.h")
#import "ExpoAppleVisionFace/ExpoAppleVisionFace-Swift.h"
#else
#import "ExpoAppleVisionFace-Swift.h"
#endif

@interface AppleVisionFaceDetector (FrameProcessorPluginLoader)
@end

@implementation AppleVisionFaceDetector (FrameProcessorPluginLoader)
+ (void)load {
  [FrameProcessorPluginRegistry addFrameProcessorPlugin:@"detectFacesVision"
    withInitializer:^FrameProcessorPlugin*(VisionCameraProxyHolder* proxy, NSDictionary* options) {
    return [[AppleVisionFaceDetector alloc] initWithProxy:proxy withOptions:options];
  }];
}
@end
