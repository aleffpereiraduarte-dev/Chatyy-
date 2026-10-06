import { NativeModule, requireOptionalNativeModule } from 'expo';

/**
 * Stage 8: Encrypted SQLite chat snapshot backup.
 *
 * iOS  → iCloud Drive (user's iCloud, NOT Chatyy servers)
 * Android → Google Drive (user's Drive)
 *
 * The chatyy.db SQLite file is encrypted client-side with AES-256-GCM
 * using a key derived from the user's password via PBKDF2-SHA256
 * (600,000 iterations, 32-byte salt). The password is NEVER sent
 * to Chatyy servers.
 *
 * File format on disk in the cloud:
 *   [magic 4B 'CYB1'][salt 32B][iv 12B][ciphertext][gcmTag 16B]
 *
 * Backups are listed/restored from the user's own cloud — Chatyy is
 * never an intermediary and never sees the encrypted blob either.
 */

export type BackupInfo = {
  filename: string;
  createdAt: string; // ISO8601
  size: number;     // bytes
};

export type BackupResult = {
  uploaded: true;
  size: number;
};

export type RestoreResult = {
  restored: true;
  messageCount: number;
};

declare class ExpoChatBackupModuleClass extends NativeModule {
  /**
   * Encrypt the current chatyy.db SQLite file with PBKDF2(password) →
   * AES-256-GCM and upload to the user's iCloud Drive (iOS) or Google
   * Drive (Android) as `chatyy-backup-YYYYMMDD.bin`. Replaces a same-day
   * file if it already exists.
   */
  backupNow(password: string): Promise<BackupResult>;

  /**
   * List backups present in the user's cloud (does NOT hit Chatyy
   * servers). On Android, may prompt for Google Sign-In on first call.
   */
  listBackups(): Promise<BackupInfo[]>;

  /**
   * Download the chosen backup from cloud, decrypt with the supplied
   * password, write to a temp location, then swap the SQLite file in
   * atomically. Returns the number of messages found in the restored
   * database (sanity-check value for the UI).
   */
  restoreFromBackup(filename: string, password: string): Promise<RestoreResult>;

  /**
   * Register a daily background backup task. The actual encryption is
   * done client-side at run-time using the password the user supplied
   * via Keychain / Keystore (cached during `backupNow`). Pass
   * `intervalDays = 1` for daily (default), or larger.
   */
  scheduleAutomaticBackup(intervalDays?: number): Promise<void>;
}

// [2026-10-06] requireOptionalNativeModule em vez de requireNativeModule: o
// segundo LANÇA no init do módulo e, quando o require() é preguiçoso (fora do
// guard do Metro), vira reportFatalError → o app FECHA (mesma classe do crash
// "Cannot find native module 'ExpoChatCacheModule'" no logout Android). Aqui
// cada wrapper rejeita a Promise com um Error normal, que os call sites já tratam.
const ExpoChatBackup = requireOptionalNativeModule<ExpoChatBackupModuleClass>('ExpoChatBackupModule');
function N(): ExpoChatBackupModuleClass {
  if (!ExpoChatBackup) throw new Error('ExpoChatBackupModule native module unavailable on this platform/build');
  return ExpoChatBackup;
}

export async function backupNow(password: string): Promise<BackupResult> {
  return N().backupNow(password);
}

export async function listBackups(): Promise<BackupInfo[]> {
  return N().listBackups();
}

export async function restoreFromBackup(filename: string, password: string): Promise<RestoreResult> {
  return N().restoreFromBackup(filename, password);
}

export async function scheduleAutomaticBackup(intervalDays: number = 1): Promise<void> {
  return N().scheduleAutomaticBackup(intervalDays);
}

export default ExpoChatBackup;
