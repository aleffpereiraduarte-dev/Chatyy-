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
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCp1k_ZJaUVD3O8htDoJxL59wEVk2vXEy0',
  authDomain: 'onemundo-52ca6.firebaseapp.com',
  projectId: 'onemundo-52ca6',
  storageBucket: 'onemundo-52ca6.appspot.com',
  messagingSenderId: '782929446226',
  appId: '1:782929446226:web:0', // overridden if a web appId is configured
};

// VAPID public key (server-side private key lives in /etc/onemundo-firebase-sa.json
// — Firebase uses its own VAPID under the hood for Web Push so this is the
// "Web push certificate" from Firebase Console → Project settings → Cloud
// Messaging → Web configuration. If unset, getToken returns null.
//
// MUST be configured before web push works. To get it: Firebase Console →
// onemundo-52ca6 → Project settings → Cloud Messaging → Web Push certificates
// → Generate key pair. Paste the resulting "Key pair" value below.
const VAPID_PUBLIC_KEY = ''; // <-- TODO ops: paste VAPID public key here

let _registering = false;
let _registered = false;

export async function registerForWebPush() {
  if (Platform.OS !== 'web') return null;
  if (typeof window === 'undefined') return null;
  if (_registered || _registering) return null;
  _registering = true;
  try {
    // Permission gate first
    if (!('Notification' in window)) return null;
    if (Notification.permission === 'denied') return null;
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return null;
    }

    if (!VAPID_PUBLIC_KEY) {
      // Web push is gated on ops shipping a VAPID public key. Until then the
      // platform falls back to in-app + native push, so this is expected on
      // the web build. Keep the log out of production console — it confused
      // users investigating F12 (looked like a bug, isn't).
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[webPush] VAPID public key not configured — skipping');
      }
      return null;
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
      console.warn('[webPush] getToken returned empty');
      return null;
    }
    const { apiCall } = require('./api');
    const r = await apiCall('register_web_push_token', { token }, 'POST');
    if (r?.success) {
      _registered = true;
      console.log('[webPush] registered, token len=', token.length);
    } else {
      console.warn('[webPush] backend rejected token:', r?.error);
    }
    return token;
  } catch (err) {
    console.warn('[webPush] registration failed:', err?.message || err);
    return null;
  } finally {
    _registering = false;
  }
}
