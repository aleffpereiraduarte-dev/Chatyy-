import { NativeModule, requireNativeModule } from 'expo';
import { ExpoBackgroundUploadModuleEvents, UploadRequest } from './expo-background-upload.types';

declare class ExpoBackgroundUploadModuleClass extends NativeModule<ExpoBackgroundUploadModuleEvents> {
  uploadAsset(request: UploadRequest): Promise<{ assetId: string; queued: boolean }>;
  uploadBatch(requests: UploadRequest[]): Promise<{ queued: number; failed: number }>;
  getActiveCount(): Promise<number>;
  cancelAll(): void;
}

export default requireNativeModule<ExpoBackgroundUploadModuleClass>('ExpoBackgroundUpload');
