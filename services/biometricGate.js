/**
 * Biometric gate for destructive / sensitive actions.
 *
 * Wraps `expo-local-authentication` so call sites don't need to repeat the
 * "Face ID / Touch ID / device passcode" boilerplate. The gate is a soft
 * security primitive — it doesn't keep secrets, it just confirms a human
 * is at the device before we delete a chat, change a password, unlink a
 * companion device, or disable 2FA. If biometrics aren't available (web,
 * unenrolled device, hardware missing) the gate falls back to device
 * passcode via `disableDeviceFallback: false`. If even that's missing the
 * function resolves `true` so we don't deadlock the user — the surface
 * that called us is expected to re-confirm via a second alert in that
 * edge case.
 *
 * Usage:
 *   import { confirmWithBiometric } from '../services/biometricGate';
 *   const ok = await confirmWithBiometric({
 *     reason: 'Apagar conversa',
 *     fallback: 'Use o passcode do aparelho',
 *   });
 *   if (!ok) return;
 *   // ...proceed with the destructive action.
 */
import { Platform } from 'react-native';

let _LA = null;
if (Platform.OS !== 'web') {
  try { _LA = require('expo-local-authentication'); } catch {}
}

/**
 * @param {object} opts
 * @param {string} [opts.reason]   Prompt message shown above Face ID dialog.
 * @param {string} [opts.fallback] Label for the "use passcode" button.
 * @param {string} [opts.cancel]   Label for the cancel button.
 * @returns {Promise<boolean>}     true on success, false on cancel / error.
 */
export async function confirmWithBiometric({ reason, fallback, cancel } = {}) {
  // Web has no native biometric API — caller is expected to gate via
  // password re-entry or a confirm dialog instead.
  if (Platform.OS === 'web' || !_LA) return true;
  try {
    const [hasHw, enrolled] = await Promise.all([
      _LA.hasHardwareAsync().catch(() => false),
      _LA.isEnrolledAsync().catch(() => false),
    ]);
    // No hardware OR no enrolled credential → don't block the user; the
    // call site should still have shown a confirm dialog before us.
    if (!hasHw || !enrolled) return true;
    const res = await _LA.authenticateAsync({
      promptMessage: reason || 'Confirme com Face ID / digital',
      fallbackLabel: fallback || 'Usar passcode',
      cancelLabel: cancel || 'Cancelar',
      // Allow the OS to fall back to the device PIN/passcode after a few
      // failed bio attempts — keeps users with damaged fingerprints / face
      // out of a hard wall.
      disableDeviceFallback: false,
    });
    return !!(res && res.success);
  } catch {
    // Surface a fail-closed result on unexpected throws so a buggy native
    // module can't accidentally green-light a destructive action.
    return false;
  }
}

export default { confirmWithBiometric };
