// modules/expo-photos-backup — [2026-10-15 photos-native]
//
// Backup de fotos/vídeos NATIVO (motor fora do JS):
//   iOS: PhotoKit (persistent changes + observer) → exporta ORIGINAL →
//        SHA-256 → drive_init_upload (dedupe) → PUT no R2 por URLSession
//        BACKGROUND (segue com o app fechado) → drive_confirm_upload.
//        BGProcessingTask/BGAppRefreshTask preparam os lotes.
//   Android: WorkManager (Wi-Fi/carregando/bateria ok) + ContentUriTriggers +
//        MediaStore generation, foreground DATA_SYNC discreto.
// Fila durável SQLite POR CONTA; trocar de conta isola a anterior.
// Binário sem o módulo → isAvailable() false e o app usa o fluxo antigo.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type BackupState = 'cloud' | 'uploading' | 'pending' | 'failed';
export type BlockedBy = null | 'disabled' | 'auth' | 'permission' | 'quota' | 'network' | 'wifi' | 'charging' | 'battery';

export type BackupConfig = {
  account: string;
  token: string;
  apiBase: string;
  fallbackBase?: string;
  enabled?: boolean;
  wifiOnly?: boolean;
  chargingOnly?: boolean;
  quality?: 'original' | 'economy';
  includeVideos?: boolean;
  notify?: boolean;
  labels?: Record<string, string>;
};

export type BackupStatus = {
  enabled: boolean; paused: boolean; running: boolean;
  total: number; done: number; pending: number; uploading: number; failed: number; skipped: number;
  bytesDone: number; lastRunAt: number; lastError: string; blockedBy: BlockedBy; account: string;
};

export type BackupSnapshot = { cloud: string[]; pending: string[]; uploading: string[]; failed: string[]; local?: string[] };

type NativeMod = {
  apiVersion(): number;
  configure(c: BackupConfig): Promise<boolean>;
  signOut(): Promise<boolean>;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  runNow(): Promise<boolean>;
  getStatus(): Promise<BackupStatus>;
  getSnapshot(): Promise<BackupSnapshot>;
  addListener(name: 'onProgress' | 'onItem' | 'onState', cb: (e: any) => void): { remove(): void };
};

let _mod: NativeMod | null | undefined;

export function native(): NativeMod | null {
  if (_mod !== undefined) return _mod;
  try {
    _mod = (requireOptionalNativeModule('ChatyyPhotosBackup') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

/** Kill switch OTA/console: globalThis.__chatyy_native_backup = false. */
export function isAvailable(): boolean {
  try {
    if ((globalThis as any).__chatyy_native_backup === false) return false;
  } catch {}
  const m = native();
  if (!m || typeof m.apiVersion !== 'function') return false;
  try { return Number(m.apiVersion()) >= 1; } catch { return false; }
}
