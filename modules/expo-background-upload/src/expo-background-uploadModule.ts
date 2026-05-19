import { NativeModule, requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import { ExpoBackgroundUploadModuleEvents, UploadRequest } from './expo-background-upload.types';

declare class ExpoBackgroundUploadModuleClass extends NativeModule<ExpoBackgroundUploadModuleEvents> {
  // iOS-only orchestration helpers (kept for the existing iOS path)
  uploadAsset(request: UploadRequest): Promise<{ assetId: string; queued: boolean }>;
  uploadBatch(requests: UploadRequest[]): Promise<{ queued: number; failed: number }>;
  getActiveCount(): Promise<number>;
  cancelAll(): void;
  // Android-side native primitives (also no-op on iOS — iOS does its own thing
  // inside the Swift module).
  scanMediaStore?(sinceMs: number | null): Promise<any[]>;
  hashFile?(uri: string): Promise<string>;
  compressImage?(uri: string, maxDim: number, quality: number): Promise<{
    uri: string; path: string; size: number; width: number; height: number;
  }>;
  uploadToR2?(localPath: string, presignedUrl: string, assetId?: string, mimeType?: string): Promise<{
    uploaded: boolean; status: number; etag: string;
  }>;
  scheduleBackup?(wifiOnly: boolean, chargingOnly: boolean): Promise<void>;
  cancelBackup?(): Promise<void>;
  setBackupCreds?(bearer: string, apiBase: string, email: string): Promise<void>;
  /** [JS bridge, 2026-05-19] Drain the worker's delta file (Android only).
   *  Returns { ids: string[], updated_at: number } — JS merges the ids into
   *  the @chatyy_backup/backed_up_map AsyncStorage key. Deletes the file on
   *  read so subsequent calls return an empty list (until the worker runs
   *  again). On iOS / web returns `{ ids: [], updated_at: 0 }`. */
  reconcileWorkerBackedUp?(): Promise<{ ids: string[]; updated_at: number }>;
  // 2026-05-18: gate the native "X fotos salvas" / "Backup concluído"
  // local notification posted by notifyBackupComplete. Default ON.
  setBackupNotificationsEnabled?(enabled: boolean): void;
  isBackupNotificationsEnabled?(): boolean;
}

// No-op stub for web and unsupported platforms. Without this,
// `require('../modules/expo-background-upload')` calls
// requireNativeModule('ExpoBackgroundUpload') which throws fatal
// "Cannot find native module" on any platform without the native binary,
// crashing the screen (Backup tab branca no Android — log 2026-05-04).
// Stub returns null/empty for JS callers that don't gate on Platform.
const NoOpModule: any = {
  addListener: () => ({ remove: () => {} }),
  removeListener: () => {},
  removeAllListeners: () => {},
  uploadAsset: async () => ({ assetId: '', queued: false }),
  uploadBatch: async () => ({ queued: 0, failed: 0 }),
  getActiveCount: async () => 0,
  cancelAll: () => {},
  scanLibrary: async () => ({ scanned: 0, total: 0, isComplete: true }),
  startNativeBackup: async () => ({ uploaded: 0, error: 'unsupported_platform' }),
  stopBackup: () => {},
  resetBackedUpIds: () => {},
  setBackedUpIds: () => {},
  getBackedUpCount: () => 0,
  setBackupCreds: () => {},
  requestBackgroundBackupNow: () => {},
  setBackupNotificationsEnabled: () => {},
  isBackupNotificationsEnabled: () => true,
  reconcileWorkerBackedUp: async () => ({ ids: [], updated_at: 0 }),
};

let mod: ExpoBackgroundUploadModuleClass | any = NoOpModule;
if (Platform.OS === 'ios' || Platform.OS === 'android') {
  try {
    mod = requireNativeModule<ExpoBackgroundUploadModuleClass>('ExpoBackgroundUpload');
  } catch (e) {
    // Fallback if the module wasn't registered (TestFlight beta, prebuild --clean
    // before native rebuild, etc.). Better to silently degrade than crash.
    mod = NoOpModule;
  }
}

export default mod;
