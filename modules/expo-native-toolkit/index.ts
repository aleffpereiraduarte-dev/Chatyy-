import { requireNativeView } from 'expo';

export { default as Toolkit } from './src/Toolkit';
export { default as Audio } from './src/Audio';
export { default as Image } from './src/Image';
export { default as PdfView } from './src/PdfView';
export { default as HtmlView } from './src/HtmlView';
export { default as Intents } from './src/Intents';

// View modules added in #234/#236 — exported as React components.
//
// Wrap each requireNativeView in try/catch so a missing native module
// (e.g. running on Android, or on an older binary that doesn't have these
// view modules yet) doesn't crash the entire JS bundle on import.
function safeNativeView(name: string): any {
  try { return requireNativeView(name); } catch { return null; }
}

export const ImageZoomView = safeNativeView('ExpoNativeImageZoomView');
export const VideoPlayer = safeNativeView('ExpoNativeVideoPlayer');
export const MapView = safeNativeView('ExpoNativeMapView');
export const DrawView = safeNativeView('ExpoNativeDrawView');
export const BlurView = safeNativeView('ExpoNativeBlurView');
export const LinkPreview = safeNativeView('ExpoNativeLinkPreview');
export const TypingIndicator = safeNativeView('ExpoNativeTypingIndicator');
export const Skeleton = safeNativeView('ExpoNativeSkeleton');
export const Wallpaper = safeNativeView('ExpoNativeWallpaper');
