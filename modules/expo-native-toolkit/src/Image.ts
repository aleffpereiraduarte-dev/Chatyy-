import { requireNativeModule } from 'expo';

declare class ImageClass {
  /**
   * Resize + compress an image. Returns { uri, width, height, sizeBytes }.
   * Uses Core Image (much faster than expo-image-manipulator).
   */
  resize(input: {
    uri: string;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number; // 0..1
    format?: 'jpeg' | 'heic' | 'png';
  }): Promise<{ uri: string; width: number; height: number; sizeBytes: number }>;

  /** Generate a thumbnail for a video file. */
  videoThumbnail(input: {
    uri: string;
    timeSec?: number;
    maxWidth?: number;
  }): Promise<{ uri: string; width: number; height: number }>;

  /** Apply a Core Image filter (blur, sepia, mono, vivid, etc). */
  applyFilter(input: { uri: string; filter: string; intensity?: number }): Promise<{ uri: string }>;
}

export default requireNativeModule<ImageClass>('ExpoNativeImage');
