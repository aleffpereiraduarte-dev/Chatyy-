import { requireOptionalNativeModule } from 'expo';

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

// ⚠️ This module (NWPathMonitor reachability, Core Haptics, SFSpeechRecognizer)
// is iOS-ONLY — there is no `ExpoNativeToolkit` Android module. Using the
// THROWING `requireNativeModule` here meant that simply *importing* this file
// crashed the whole JS bundle on Android — and because index.ts statically
// re-exports `Toolkit`, that crash fired the instant ANY code path imported the
// package (e.g. the voice recorder doing
// `require('../modules/expo-native-toolkit').Audio`). Symptom: "using voice
// message features results in application crash" + push_diag
// `Cannot find native module 'ExpoNativeToolkit'` fatals on Android (2026-05-27).
//
// Fix: `requireOptionalNativeModule` returns null instead of throwing when the
// native module is absent. We fall back to a no-op stub so even an unguarded
// caller (`Toolkit.hapticImpact(...)`) degrades gracefully instead of NPE-ing.
// `isOnlineSync` defaults to `true` so Android never shows a false offline
// banner (real connectivity is covered by the JS-level reachability/fetch path).
const _native = requireOptionalNativeModule<ToolkitClass>('ExpoNativeToolkit');

const _stub: ToolkitClass = {
  isOnlineSync: () => true,
  connectionTypeSync: () => 'unknown',
  startReachability: async () => {},
  stopReachability: async () => {},
  hapticImpact: () => {},
  hapticNotification: () => {},
  hapticPattern: async () => {},
  requestSpeechPermission: async () => false,
  transcribeAudioFile: async () => {
    throw new Error('Speech transcription is not available on this platform');
  },
} as unknown as ToolkitClass;

// [2026-10-09 android-ml-parity] Android has no ExpoNativeToolkit module, but
// the next binary ships on-device transcription (platform SpeechRecognizer,
// Android 13+) in the Android ExpoNativeChatSecurity module with the SAME
// signatures as iOS. Route the two speech functions there when present, so
// `Toolkit.transcribeAudioFile` works on both platforms. Old binaries: the
// module is absent → the stub (throws / false) exactly as before.
if (!_native) {
  const _sec = requireOptionalNativeModule<any>('ExpoNativeChatSecurity');
  if (_sec && typeof _sec.transcribeAudioFile === 'function') {
    _stub.transcribeAudioFile = (fileUrl: string, locale?: string) => _sec.transcribeAudioFile(fileUrl, locale ?? null);
    if (typeof _sec.requestSpeechPermission === 'function') {
      _stub.requestSpeechPermission = () => _sec.requestSpeechPermission();
    }
  }
}

export default (_native ?? _stub) as ToolkitClass;
