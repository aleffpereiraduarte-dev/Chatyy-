import { NativeModule, requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import { ExpoBackgroundUploadModuleEvents, UploadRequest } from './expo-background-upload.types';

declare class ExpoBackgroundUploadModuleClass extends NativeModule<ExpoBackgroundUploadModuleEvents> {
  uploadAsset(request: UploadRequest): Promise<{ assetId: string; queued: boolean }>;
  uploadBatch(requests: UploadRequest[]): Promise<{ queued: number; failed: number }>;
  getActiveCount(): Promise<number>;
  cancelAll(): void;
}

// No-op stub for Android/web — modulo nativo so existe pro iOS.
// Sem isso, `require('../modules/expo-background-upload')` chamava
// requireNativeModule('ExpoBackgroundUpload') que lanca fatal error
// "Cannot find native module" em qualquer plataforma sem o nativo,
// crashando a tela inteira (Backup tab branca no Android — log
// 2026-05-04 mostra esse erro). Stub retorna null/empty pros JS callers.
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
};

let mod: ExpoBackgroundUploadModuleClass | any = NoOpModule;
if (Platform.OS === 'ios') {
  try {
    mod = requireNativeModule<ExpoBackgroundUploadModuleClass>('ExpoBackgroundUpload');
  } catch (e) {
    // Fallback se modulo nao registrado por algum motivo (TestFlight beta etc).
    mod = NoOpModule;
  }
}

export default mod;
