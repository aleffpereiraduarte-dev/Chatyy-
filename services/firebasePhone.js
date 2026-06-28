// firebasePhone.js — NATIVE Firebase Phone Auth via a hidden WebView.
//
// Google/Firebase sends the OTP SMS (best Brazil deliverability, and the only
// channel left after every paid SMS provider blocked the account). Firebase
// Phone Auth needs reCAPTCHA, which only runs in a real DOM — so instead of the
// @react-native-firebase native pod (it broke the iOS Archive: FirebaseAuth
// Swift header not found, commit c492cffc), we run the whole flow inside
// components/FirebasePhoneHost (a WebView on https://chatyy.com.br/fbphone.html)
// and talk to it through `fbBus`. NO native dependency → ships 100% via OTA.
//
// The backend exchanges the resulting Firebase ID token for a Chatyy session
// (email.php → phone_login_firebase → api/firebase-verify.php). Every function
// fails soft so login.js / signup-phone.js fall back to the backend OTP path.
//
// Web resolves to firebasePhone.web.js (runs the same flow inline in the
// browser DOM — no WebView needed).

import { Platform } from 'react-native';
import { fbBus } from '../components/FirebasePhoneHost';

let _webViewMissing = false;
try {
  // Probe once: if react-native-webview isn't linked we can't run Firebase, so
  // firebasePhoneAvailable() returns false and callers use the backend OTP.
  // eslint-disable-next-line global-require
  require('react-native-webview');
} catch (e) {
  _webViewMissing = true;
}

// Available on native only, and only when the WebView module is present.
export function firebasePhoneAvailable() {
  // [2026-06-26] Firebase SMS DESLIGADO — OTP vai pelo backend (MSG91 p/ EUA, Infobip p/ resto).
  return false;
}

// Send the verification SMS. Returns { ok, confirmation } or { ok:false, error }.
// `confirmation` holds the verificationId; pass it back to fbConfirm().
export async function fbSendCode(e164Phone) {
  if (!firebasePhoneAvailable()) return { ok: false, error: 'unavailable' };
  try {
    const r = await fbBus.run({ cmd: 'send', phone: String(e164Phone) }, 90000);
    if (r && r.ev === 'sent' && r.verificationId) {
      return { ok: true, confirmation: { verificationId: r.verificationId } };
    }
    return { ok: false, error: (r && r.code) || 'send_failed', message: (r && r.message) || '' };
  } catch (e) {
    return { ok: false, error: 'send_failed', message: String((e && e.message) || e) };
  }
}

// Confirm the typed code → { ok, idToken } or { ok:false, error }.
// `wrong_code` = the user mistyped/expired (stay on screen); any other error
// means Firebase failed and the caller should fall back to backend OTP.
export async function fbConfirm(confirmation, code) {
  if (!confirmation || !confirmation.verificationId) return { ok: false, error: 'no_confirmation' };
  try {
    const r = await fbBus.run(
      { cmd: 'confirm', verificationId: confirmation.verificationId, code: String(code) },
      60000
    );
    if (r && r.ev === 'token' && r.idToken) return { ok: true, idToken: r.idToken };
    const codeStr = (r && r.code) || '';
    const wrong = /invalid-verification-code|invalid-code|code-expired|session-expired|missing-code|missing-verification-code/i.test(codeStr);
    return { ok: false, error: wrong ? 'wrong_code' : (codeStr || 'confirm_failed'), message: (r && r.message) || '' };
  } catch (e) {
    return { ok: false, error: 'confirm_failed', message: String((e && e.message) || e) };
  }
}

// Tear down the WebView flow once the Chatyy session is established.
export async function fbSignOut() {
  try { fbBus.reset(); } catch (e) {}
}
