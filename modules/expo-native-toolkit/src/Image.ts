import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

declare class ImageClass {
  /**
   * Resize + compress an image. Returns { uri, width, height, sizeBytes }.
   * iOS uses Core Image; Android uses BitmapFactory + Bitmap.compress.
   * Both paths strip EXIF (privacy-friendly).
   */
  resize(input: {
    uri: string;
    maxWidth?: number;
    maxHeight?: number;
    /** 0..1 to match iOS; 1..100 also accepted on Android for legacy callers. */
    quality?: number;
    format?: 'jpeg' | 'heic' | 'png' | 'webp';
  }): Promise<{ uri: string; width: number; height: number; sizeBytes: number }>;

  /** Generate a thumbnail for a video file. */
  videoThumbnail(input: {
    uri: string;
    /** Time in seconds (iOS-style). Android also accepts `atMs`. */
    timeSec?: number;
    atMs?: number;
    maxWidth?: number;
  }): Promise<{ uri: string; width: number; height: number }>;

  /** Header-only dimensions read (Android). iOS callers should use UIImage(contentsOfFile:). */
  getDimensions?(srcUri: string): Promise<{ width: number; height: number; mimeType: string }>;

  /** Apply a Core Image filter (iOS). On Android this is a copy/pass-through stub. */
  applyFilter(input: { uri: string; filter?: string; intensity?: number }): Promise<{ uri: string }>;
}

const ImageMod: ImageClass | null = (() => {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    return requireNativeModule<ImageClass>('ExpoNativeImage');
  } catch {
    return null;
  }
})();

export default ImageMod as ImageClass;
