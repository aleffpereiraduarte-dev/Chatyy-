// services/webPush.js
//
// Web-only FCM push registration. Loads the Firebase Web SDK lazily from
// the official CDN (no bundle bloat — module isn't downloaded until the
// user opts in to web push), calls getToken({ vapidKey }), and POSTs the
// resulting token to backend `register_web_push_token`.
//
// 2026-05-17 — gap_notifications P0+P1 step 7.

import { Platform } from 'react-native';

// Project-specific config. Mirror of GoogleService-Info.plist /
// google-services.json — these values are safe to ship to the client
// (they're public per Google).
// [webpush-fix 2026-06-03] Config REAL do web app Firebase, puxada via
// firebase.googleapis.com/v1beta1/projects/onemundo-52ca6/webApps/.../config.
// A versão anterior usava uma apiKey que NÃO existe no projeto + um appId
// FAKE ('...web:0') → Installations retornava 400 "API key not valid" e o
// web push nunca registrava. Validado: POST /v1/installations com esta key
// + appId → 200.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC5943EdhMUcoDX4cX15UBnsO1Xihuf_sE',
  authDomain: 'onemundo-52ca6.firebaseapp.com',
  projectId: 'onemundo-52ca6',
  storageBucket: 'onemundo-52ca6.firebasestorage.app',
  messagingSenderId: '782929446226',
  appId: '1:782929446226:web:90a36e056b392a6294268b',
  measurementId: 'G-TCHEBQZD73',
};

// VAPID public key (server-side private key lives in /etc/onemundo-firebase-sa.json
// — Firebase uses its own VAPID under the hood for Web Push so this is the
// "Web push certificate" from Firebase Console → Project settings → Cloud
// Messaging → Web configuration. If unset, getToken returns null.
//
// MUST be configured before web push works. To get it: Firebase Console →
// onemundo-52ca6 → Project settings → Cloud Messaging → Web Push certificates
// → Generate key pair. Paste the resulting "Key pair" value below.
// [2026-05-18] VAPID key from /etc/mail-api.env on prod server.
// Without this getToken returns null and desktop web push is broken.
const VAPID_PUBLIC_KEY = 'BNpEc6JEF0FadT6pME0Mhf4XViw-JTDMmuUT_Ga6hEWujYNace8RVlJlYxb5ByprKS2DiO6PbbqncgDepIoA60M';

let _registering = false;
let _registered = false;
// Cache the last successfully-registered web push token so logout can call
// the backend `unregister_web_push_token` action without re-running
// getToken(). getToken() is cheap but requires the SW to be ready and
// permission still granted — neither holds during teardown.
let _cachedWebToken = null;

// Typed status so Settings/diagnostics can surface WHY web push is off instead
// of a silent null. Set by the getToken path; read via getWebPushStatus().
//   IDLE             — not yet attempted
//   MISSING_VAPID    — VAPID public key absent/empty on a production build
//   UNSUPPORTED      — not web, no Notification API, etc.
//   DENIED           — user denied notification permission
//   REGISTERED       — token obtained + accepted by backend
//   EMPTY_TOKEN      — getToken() returned empty
//   ERROR            — registration threw
let _status = 'IDLE';
export function getWebPushStatus() { return _status; }

// [2026-07-02] KILL-SWITCH for browser web push. It is currently broken by a
// Firebase JS SDK anomaly: getToken() → fcmregistrations 401 "missing required
// authentication credential", which dumped a huge error stack in the console on
// EVERY boot for users who'd granted permission. Server/config/VAPID are all
// verified correct — it's SDK-internal. Since the feature never succeeds anyway
// (100% broken), we skip the whole path to keep the console clean. MOBILE push
// (native FCM) is completely unaffected. Flip to true after fixing the SDK path
// (DevTools → Network → fcmregistrations → compare x-goog-* headers).
const WEB_PUSH_ENABLED = false;

export async function registerForWebPush(interactive = false) {
  if (Platform.OS !== 'web') return null;
  if (typeof window === 'undefined') return null;
  if (!WEB_PUSH_ENABLED) { _status = 'DISABLED'; return null; }
  if (_registered || _registering) return null;
  _registering = true;
  try {
    // VAPID is a HARD requirement for web push — getToken() cannot succeed
    // without it. Check before the permission prompt so we don't ask the user
    // for a permission we can't use. An empty key on a production build is a
    // real misconfiguration (ops didn't ship the Web Push certificate), so
    // log it loudly and expose MISSING_VAPID for Settings to surface. We do
    // NOT throw — boot must not break — we just fail this path with a status.
    if (!VAPID_PUBLIC_KEY) {
      _status = 'MISSING_VAPID';
      const isDev = (typeof __DEV__ !== 'undefined' && __DEV__);
      if (isDev) {
        console.warn('[webPush] VAPID public key not configured — skipping');
      } else {
        console.error('[webPush] MISSING_VAPID: web push certificate not configured on this build — web push is disabled. Configure VAPID_PUBLIC_KEY (Firebase Console → Cloud Messaging → Web Push certificates).');
      }
      return null;
    }

    // Permission gate (after the VAPID check above)
    if (!('Notification' in window)) { _status = 'UNSUPPORTED'; return null; }
    if (Notification.permission === 'denied') { _status = 'DENIED'; return null; }
    if (Notification.permission !== 'granted') {
      // Notification.requestPermission() MUST be triggered by a user gesture —
      // calling it on boot/auto-registration shows an unsolicited browser
      // prompt (and some browsers now ignore non-gesture requests entirely).
      // When not interactive we bail with a status the UI can surface via a
      // toggle; the explicit gesture path is requestWebPushPermission().
      if (!interactive) { _status = 'PERMISSION_REQUIRED'; return null; }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { _status = 'DENIED'; return null; }
    }

    // Wait for service worker (already registered by _layout.js useEffect).
    const reg = await navigator.serviceWorker.ready;

    // Dynamic ESM import from CDN. Skypack is reliable and ships ESM
    // bundles of Firebase modular SDK with the same surface as npm.
    // Pin version to keep the surface stable.
    const { initializeApp } = await import(
      /* webpackIgnore: true */ 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
    );
    const { getMessaging, getToken } = await import(
      /* webpackIgnore: true */ 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js'
    );
    const app = initializeApp(FIREBASE_CONFIG);
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: reg,
    });
    if (!token) {
      _status = 'EMPTY_TOKEN';
      console.warn('[webPush] getToken returned empty');
      return null;
    }
    const { apiCall } = require('./api');
    const r = await apiCall('register_web_push_token', { token }, 'POST');
    if (r?.success) {
      _registered = true;
      _cachedWebToken = token;
      _status = 'REGISTERED';
      console.log('[webPush] registered, token len=', token.length);
    } else {
      _status = 'ERROR';
      console.warn('[webPush] backend rejected token:', r?.error);
    }
    return token;
  } catch (err) {
    _status = 'ERROR';
    console.warn('[webPush] registration failed:', err?.message || err);
    return null;
  } finally {
    _registering = false;
  }
}

/**
 * Gesture-path entry point. MUST be called from inside a user-gesture handler
 * (e.g. a "Enable notifications" toggle/button onPress) so the browser allows
 * Notification.requestPermission(). Boot/auto-registration must keep calling
 * registerForWebPush() (non-interactive) which never prompts on its own.
 */
export async function requestWebPushPermission() {
  return registerForWebPush(true);
}

/**
 * Logout-side mirror — POST to backend `unregister_web_push_token` so the
 * browser stops receiving pushes for the user that just logged out. Called
 * from pushNotifications.removeTokenFromBackend() on the web platform.
 *
 * Best-effort: if the cached token is missing we still POST with empty
 * string so the backend can short-circuit gracefully. The matching server
 * action lives in /var/www/mail/api/email.php (`unregister_web_push_token`).
 */
export async function unregisterWebPushToken() {
  if (Platform.OS !== 'web') return null;
  const token = _cachedWebToken;
  _cachedWebToken = null;
  _registered = false;
  if (!token) return null;
  try {
    const { apiCall } = require('./api');
    const r = await apiCall('unregister_web_push_token', { token }, 'POST');
    return r;
  } catch (err) {
    console.warn('[webPush] unregister failed:', err?.message || err);
    return null;
  }
}
