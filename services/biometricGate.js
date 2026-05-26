/**
 * Biometric gate for destructive / sensitive actions.
 *
 * Wraps `expo-local-authentication` so call sites don't need to repeat the
 * "Face ID / Touch ID / device passcode" boilerplate. The gate is a soft
 * security primitive — it doesn't keep secrets, it just confirms a human
 * is at the device before we delete a chat, change a password, unlink a
 * companion device, or disable 2FA. If biometrics aren't available (web,
 * unenrolled device, hardware missing) the gate falls back to device
 * passcode via `disableDeviceFallback: false`. If even that's missing we no
 * longer silently resolve `true` (that was a fail-OPEN hole: a device with no
 * Face ID / Touch ID / passcode enrolled could delete a chat, change the
 * password, unlink a device, or disable 2FA with zero human confirmation).
 * Instead we show a blocking yes/no confirm (`Alert` on native,
 * `window.confirm` on web) so a destructive action ALWAYS requires an explicit
 * second tap. Callers don't need to change — the secondary confirm is built in.
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
import { Platform, Alert } from 'react-native';

// Blocking yes/no confirm used when no real biometric/passcode factor is
// available. Resolves true only on the user's explicit affirmative tap, so the
// "no hardware" path can never silently green-light a destructive action.
function _secondaryConfirm({ reason, cancel } = {}) {
  const title = reason || 'Confirmar';
  const message = 'Confirme esta ação.';
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return Promise.resolve(!!window.confirm(`${title}\n\n${message}`));
      }
    } catch {}
    // No confirm primitive available → fail closed.
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      Alert.alert(
        title,
        message,
        [
          { text: cancel || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Confirmar', style: 'destructive', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      );
    } catch {
      // Alert unavailable → fail closed rather than fail open.
      resolve(false);
    }
  });
}

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
  // Web has no native biometric API. Don't fail open — require an explicit
  // yes/no confirm so a destructive action still needs deliberate intent.
  if (Platform.OS === 'web' || !_LA) {
    return _secondaryConfirm({ reason, cancel });
  }
  try {
    const [hasHw, enrolled] = await Promise.all([
      _LA.hasHardwareAsync().catch(() => false),
      _LA.isEnrolledAsync().catch(() => false),
    ]);
    // No hardware OR no enrolled credential → previously returned true
    // (fail-open). Now require an explicit blocking confirm so the action
    // can't proceed silently on an unattended, un-enrolled device.
    if (!hasHw || !enrolled) return _secondaryConfirm({ reason, cancel });
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
