// =============================================================================
// [2026-10-08 android-otp-shortcuts] SMS OTP auto-read (Android SMS User Consent)
//
// Android: modules/expo-native-toolkit ExpoSmsOtpModule arms Google Play
// Services' SMS User Consent API (no READ_SMS permission, no app hash). When
// the OTP SMS arrives the system shows a one-tap consent sheet; on "Permitir"
// the native side extracts the 6-digit code and emits it here.
// iOS: no-op — textContentType="oneTimeCode" autofill already covers it.
// Web: no-op.
//
// Feature detection is LAZY: the native module is resolved with
// requireOptionalNativeModule at call time (never at import), so an older
// binary without ExpoSmsOtp just gets null → no-op (no TurboModule probing,
// no fatal on require).
// =============================================================================

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

let _mod; // undefined = not resolved yet; null = unavailable

function getModule() {
  if (Platform.OS !== 'android') return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    _mod = requireOptionalNativeModule('ExpoSmsOtp') || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isSmsOtpSupported() {
  const m = getModule();
  if (!m) return false;
  try { return m.isAvailable?.() !== false; } catch { return false; }
}

/**
 * Starts listening for the OTP SMS. Returns a stop() function (always safe to
 * call). `onCode(code)` receives a 6-digit string at most once per start.
 */
export function startSmsOtpListener(onCode) {
  const m = getModule();
  if (!m || typeof onCode !== 'function') return () => {};
  let done = false;
  let sub = null;
  try {
    sub = m.addListener?.('onSmsOtp', (e) => {
      if (done || !e || e.status !== 'code') return;
      const code = String(e.code || '').replace(/\D/g, '');
      if (code.length !== 6) return;
      done = true;
      try { onCode(code); } catch {}
    }) || null;
  } catch { sub = null; }
  try { Promise.resolve(m.start?.()).catch(() => {}); } catch {}
  return () => {
    done = true;
    try { sub?.remove?.(); } catch {}
    try { m.stop?.(); } catch {}
  };
}

/**
 * Hook: while `active` is true, listens for the OTP SMS and calls the latest
 * `onCode`. Re-arms whenever `rearmKey` changes (e.g. after "Reenviar").
 */
export function useSmsOtpAutofill(active, onCode, rearmKey) {
  const cbRef = useRef(onCode);
  cbRef.current = onCode;
  useEffect(() => {
    if (!active || Platform.OS !== 'android') return undefined;
    const stop = startSmsOtpListener((code) => { try { cbRef.current?.(code); } catch {} });
    return stop;
  }, [active, rearmKey]);
}
