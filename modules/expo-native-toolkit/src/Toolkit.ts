import { requireNativeModule } from 'expo';

declare class ToolkitClass {
  // ─── Reachability (NWPathMonitor) ──────────────────────────────
  /** True if device has internet right now (cached, sub-ms). */
  isOnlineSync(): boolean;
  /** "wifi" | "cellular" | "ethernet" | "none" */
  connectionTypeSync(): string;
  startReachability(): Promise<void>;
  stopReachability(): Promise<void>;

  // ─── Core Haptics ──────────────────────────────────────────────
  /** Single sharp tap (e.g. button press) */
  hapticImpact(intensity: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  /** Success / warning / error notification haptic */
  hapticNotification(kind: 'success' | 'warning' | 'error'): void;
  /** Custom rich haptic pattern: array of {time, intensity, sharpness} */
  hapticPattern(events: Array<{ time: number; intensity: number; sharpness: number }>): Promise<void>;

  // ─── Voice transcription (SFSpeechRecognizer) ──────────────────
  /** Request permission for speech recognition (one-time prompt). */
  requestSpeechPermission(): Promise<boolean>;
  /** Transcribe an audio file URL (file://). On-device when possible. */
  transcribeAudioFile(fileUrl: string, locale?: string): Promise<string>;
}

export default requireNativeModule<ToolkitClass>('ExpoNativeToolkit');
