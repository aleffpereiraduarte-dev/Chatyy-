// StatusPlainCamera — plain expo-camera capture for Chatyy Status (NO AR).
//
// WHY THIS EXISTS [2026-05-27, iOS build 282 P0 crash]:
//   StatusVisionCamera (react-native-vision-camera + @shopify/react-native-skia
//   + react-native-worklets-core + Apple Vision face shim) is broken / mislinked
//   on iOS build 282. When the camera mounts and the native frame-processor
//   fires, it throws an ObjC NSException whose Hermes conversion corrupts the
//   JS heap → hard native crash (EXC_BAD_ACCESS / SIGSEGV in
//   com.meta.react.turbomodulemanager.queue → convertNSExceptionToJSError).
//   A JS error boundary / React.Suspense CANNOT catch a native SIGSEGV, so the
//   only OTA-safe fix is to NOT mount the vision-camera AR stack on iOS at all.
//
//   This component is a drop-in replacement that uses expo-camera's CameraView
//   (already a dependency — StatusCamera imports useCameraPermissions from it)
//   to provide plain photo/video capture with NO AR filters. Android keeps the
//   StatusVisionCamera AR path (MLKit works there); iOS uses this stopgap until
//   AR is restored in the next NATIVE build (Apple Vision linkage).
//
// It exposes the EXACT same imperative ref surface StatusCamera consumes so the
// large capture/record logic upstream is unchanged:
//   ref.takePictureAsync({ quality }) -> { uri, width, height }
//   ref.recordAsync({ maxDuration, quality }) -> { uri }
//   ref.stopRecording()
//
// `arFilterKey` is accepted but IGNORED (no AR in this path).
import React, {
  forwardRef, useImperativeHandle, useRef, useCallback,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { CameraView } from 'expo-camera';

function StatusPlainCameraInner(
  // eslint-disable-next-line no-unused-vars
  { facing = 'front', mode = 'picture', arFilterKey = 'none', isActive = true, onError },
  ref,
) {
  const camera = useRef(null);

  // ─── Imperative API (matches StatusVisionCamera / old expo-camera surface) ───
  const takePictureAsync = useCallback(async (opts = {}) => {
    if (!camera.current) throw new Error('camera-not-ready');
    // expo-camera CameraView.takePictureAsync already returns
    // { uri, width, height, ... }. Forward the caller's options (quality, exif).
    const photo = await camera.current.takePictureAsync({
      quality: opts.quality != null ? opts.quality : 0.92,
      exif: opts.exif != null ? opts.exif : false,
    });
    if (!photo || !photo.uri) return null;
    return { uri: photo.uri, width: photo.width, height: photo.height };
  }, []);

  const recordAsync = useCallback(async (opts = {}) => {
    if (!camera.current) throw new Error('camera-not-ready');
    // CameraView.recordAsync resolves with { uri } when stopRecording fires,
    // maxDuration is hit, or the preview stops. Honor the caller's maxDuration
    // (seconds — same unit StatusCamera passed to expo-camera originally).
    const recordOpts = {};
    if (opts.maxDuration && opts.maxDuration > 0) recordOpts.maxDuration = opts.maxDuration;
    const video = await camera.current.recordAsync(recordOpts);
    if (!video || !video.uri) return null;
    return { uri: video.uri };
  }, []);

  const stopRecording = useCallback(() => {
    try { camera.current?.stopRecording?.(); } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    takePictureAsync,
    recordAsync,
    stopRecording,
  }), [takePictureAsync, recordAsync, stopRecording]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        // expo-camera CameraType is 'front' | 'back' — same values StatusCamera
        // toggles, so the facing prop passes straight through.
        facing={facing === 'back' ? 'back' : 'front'}
        // CameraMode is 'picture' | 'video' — StatusCamera already maps its
        // captureMode down to one of these before passing `mode`.
        mode={mode === 'video' ? 'video' : 'picture'}
        // StatusCamera drives mount/unmount via `isActive`; CameraView's prop
        // is `active`. Pausing the preview when the modal is hidden keeps the
        // lens from staying hot behind the preview/compose screens.
        active={isActive !== false}
        onMountError={(e) => { try { onError?.(e); } catch {} }}
      />
    </View>
  );
}

export default forwardRef(StatusPlainCameraInner);
