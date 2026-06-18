// firebasePhone.js — NATIVE (iOS + Android) Firebase Phone Auth wrapper.
//
// Why this exists (2026-06-18): the app's phone login used to send the OTP via
// our own backend (Telnyx → Vonage). Carriers in Brazil heavily filter A2P SMS,
// so codes often never arrive. Google/Firebase has direct carrier routes and is
// the most reliable SMS deliverer for BR. This module sends the code via
// Firebase; the app then exchanges the resulting Firebase ID token with our
// backend (`phone_login_firebase`) which verifies it server-side and issues the
// normal Chatyy bearer token. The backend never trusts the phone blindly — it
// validates the Google-signed JWT (see api/firebase-verify.php).
//
// EVERY function fails soft: if Firebase isn't available or errors, the caller
// (login.js / signup-phone.js) falls back to the legacy backend OTP path, so a
// misconfiguration can never lock users out.
//
// Web resolves to firebasePhone.web.js (a stub) so the native SDK is never
// bundled for the website.

import { Platform } from 'react-native';

let _authMod = null;       // namespaced auth() function
let _resolved = false;     // have we tried to require it yet?

function getAuth() {
  if (Platform.OS === 'web') return null;
  if (_resolved) return _authMod;
  _resolved = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@react-native-firebase/auth');
    _authMod = mod.default || mod;
  } catch (e) {
    _authMod = null;
  }
  return _authMod;
}

// Is the native Firebase Auth module linked AND a default app initialized?
export function firebasePhoneAvailable() {
  const auth = getAuth();
  if (!auth) return false;
  try {
    // Touching auth().app throws if no google-services default app exists.
    return !!auth().app;
  } catch (e) {
    return false;
  }
}

// Send the verification SMS. Returns { ok, confirmation } or { ok:false, error }.
// `confirmation` MUST be held by the caller and passed back to fbConfirm().
export async function fbSendCode(e164Phone) {
  const auth = getAuth();
  if (!auth) return { ok: false, error: 'unavailable' };
  try {
    const confirmation = await auth().signInWithPhoneNumber(String(e164Phone), true);
    return { ok: true, confirmation };
  } catch (e) {
    return { ok: false, error: e?.code || 'send_failed', message: e?.message || '' };
  }
}

// Confirm the typed code → returns { ok, idToken } or { ok:false, error }.
// `wrong_code` means the user mistyped (recoverable, stay on screen); any other
// error means Firebase itself failed (caller should fall back to backend OTP).
export async function fbConfirm(confirmation, code) {
  const auth = getAuth();
  if (!auth || !confirmation) return { ok: false, error: 'no_confirmation' };
  try {
    await confirmation.confirm(String(code));
    const user = auth().currentUser;
    if (!user) return { ok: false, error: 'no_user' };
    const idToken = await user.getIdToken(true);
    return { ok: true, idToken };
  } catch (e) {
    const code = e?.code || '';
    const wrong = /invalid-verification-code|invalid-code|code-expired|session-expired/i.test(code);
    return { ok: false, error: wrong ? 'wrong_code' : (code || 'confirm_failed'), message: e?.message || '' };
  }
}

// Sign the Firebase user out (housekeeping — we don't keep a Firebase session;
// the Chatyy bearer token is the real session). Best-effort, never throws.
export async function fbSignOut() {
  const auth = getAuth();
  if (!auth) return;
  try { if (auth().currentUser) await auth().signOut(); } catch (e) { /* ignore */ }
}
