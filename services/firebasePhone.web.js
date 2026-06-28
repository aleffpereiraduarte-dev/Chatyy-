// firebasePhone.web.js — WEB Firebase Phone Auth, inline in the browser DOM.
//
// The website runs in a real browser, so it can use the Firebase JS SDK +
// reCAPTCHA directly (no WebView needed). The compat SDK is loaded lazily from
// the gstatic CDN the first time a phone login is attempted, so it never bloats
// the main web bundle. chatyy.com.br is an authorized domain of the
// onemundo-52ca6 Firebase project. Backend verifies the ID token the same way
// as native (api/firebase-verify.php). Every function fails soft → the caller
// falls back to the backend OTP path.

const CFG = {
  apiKey: 'AIzaSyC5943EdhMUcoDX4cX15UBnsO1Xihuf_sE',
  authDomain: 'onemundo-52ca6.firebaseapp.com',
  projectId: 'onemundo-52ca6',
  appId: '1:782929446226:web:90a36e056b392a6294268b',
  messagingSenderId: '782929446226',
};
const SDK = 'https://www.gstatic.com/firebasejs/10.12.0';

let _auth = null;
let _initPromise = null;
let _verifier = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    try {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.getAttribute('data-loaded') === '1') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('script_error')));
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => { s.setAttribute('data-loaded', '1'); resolve(); };
      s.onerror = () => reject(new Error('script_error'));
      document.head.appendChild(s);
    } catch (e) { reject(e); }
  });
}

async function ensureAuth() {
  if (_auth) return _auth;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await loadScript(`${SDK}/firebase-app-compat.js`);
    await loadScript(`${SDK}/firebase-auth-compat.js`);
    const firebase = window.firebase;
    if (!firebase) throw new Error('firebase_unavailable');
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(CFG);
    _auth = firebase.auth();
    try { _auth.useDeviceLanguage(); } catch (e) {}
    return _auth;
  })();
  return _initPromise;
}

function ensureRecaptchaDiv() {
  let div = document.getElementById('chatyy-recaptcha');
  if (!div) {
    div = document.createElement('div');
    div.id = 'chatyy-recaptcha';
    div.style.position = 'fixed';
    div.style.bottom = '0';
    div.style.left = '0';
    document.body.appendChild(div);
  }
  return div;
}

export function firebasePhoneAvailable() {
  // [2026-06-26] Firebase SMS DESLIGADO — web tambem usa o backend OTP (MSG91/Infobip).
  return false;
}

export async function fbSendCode(e164Phone) {
  if (!firebasePhoneAvailable()) return { ok: false, error: 'unavailable' };
  try {
    const auth = await ensureAuth();
    const firebase = window.firebase;
    try { if (_verifier) _verifier.clear(); } catch (e) {}
    _verifier = new firebase.auth.RecaptchaVerifier(ensureRecaptchaDiv(), { size: 'invisible' });
    const confirmation = await auth.signInWithPhoneNumber(String(e164Phone), _verifier);
    return { ok: true, confirmation };
  } catch (e) {
    try { if (_verifier) { _verifier.clear(); _verifier = null; } } catch (_) {}
    return { ok: false, error: (e && e.code) || 'send_failed', message: String((e && e.message) || e) };
  }
}

export async function fbConfirm(confirmation, code) {
  if (!confirmation || typeof confirmation.confirm !== 'function') return { ok: false, error: 'no_confirmation' };
  try {
    const result = await confirmation.confirm(String(code));
    const user = (result && result.user) || (_auth && _auth.currentUser);
    if (!user) return { ok: false, error: 'no_user' };
    const idToken = await user.getIdToken(true);
    return { ok: true, idToken };
  } catch (e) {
    const codeStr = (e && e.code) || '';
    const wrong = /invalid-verification-code|invalid-code|code-expired|session-expired|missing-code/i.test(codeStr);
    return { ok: false, error: wrong ? 'wrong_code' : (codeStr || 'confirm_failed'), message: String((e && e.message) || e) };
  }
}

export async function fbSignOut() {
  try { if (_auth) await _auth.signOut(); } catch (e) {}
}
