import { requireNativeModule } from 'expo';

export { default } from './src/ExpoNativeChatView';

// Module-level functions (system sound playback, etc.)
const NativeModule = (() => {
  try { return requireNativeModule('ExpoNativeChatView'); }
  catch { return null; }
})();

export function playSendSound(): void {
  try { NativeModule?.playSendSound?.(); } catch {}
}

export function playReceiveSound(): void {
  try { NativeModule?.playReceiveSound?.(); } catch {}
}
