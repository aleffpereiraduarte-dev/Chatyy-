// FirebasePhoneHost.js — invisible WebView that runs Firebase Phone Auth.
//
// Why: Firebase sends the OTP SMS (Google's carrier routes = best BR
// deliverability), but Firebase Phone Auth requires reCAPTCHA app-attestation
// which only works in a real DOM. Rather than re-add @react-native-firebase
// (its Swift FirebaseAuth pod broke the iOS Archive — see commit c492cffc), we
// load a tiny page (public/fbphone.html → https://chatyy.com.br/fbphone.html)
// in a hidden WebView and drive it over postMessage. Zero native deps → 100%
// OTA. The backend verifies the resulting ID token in api/firebase-verify.php.
//
// This host is mounted ONCE in app/_layout.js. services/firebasePhone.js talks
// to it through `fbBus`. The WebView stays mounted (hidden) for the whole app
// session; it only becomes visible during the 'send' step so that, if Google
// forces a reCAPTCHA challenge, the user can solve it. The 'confirm' step needs
// no reCAPTCHA and runs invisibly.

import React, { useEffect, useRef, useState } from 'react';
import { Platform, View, StyleSheet, ActivityIndicator, Text } from 'react-native';

const PAGE_URL = 'https://chatyy.com.br/fbphone.html';

// ── Tiny controller shared with services/firebasePhone.js ──────────────────
class FbBus {
  constructor() {
    this._listeners = new Set();
    this._pending = null; // { resolve, timer }
  }
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(action) { this._listeners.forEach((l) => { try { l(action); } catch (e) {} }); }

  // Called by firebasePhone.js. Resolves with the page's reply object
  // ({ev:'sent'|'token'|'error', ...}). Never rejects — a timeout resolves to
  // an error event so callers can fall back.
  run(cmd, timeoutMs) {
    return new Promise((resolve) => {
      if (this._pending) {
        // Supersede any in-flight op (e.g. user hit resend).
        const prev = this._pending; this._pending = null;
        clearTimeout(prev.timer);
        try { prev.resolve({ ev: 'error', code: 'superseded' }); } catch (e) {}
      }
      const timer = setTimeout(() => {
        if (this._pending && this._pending.timer === timer) {
          this._pending = null;
          this._emit({ type: 'hide' });
          resolve({ ev: 'error', code: 'timeout', message: 'tempo esgotado' });
        }
      }, timeoutMs || 60000);
      this._pending = { resolve, timer };
      this._emit({ type: 'run', cmd, show: cmd.cmd === 'send' });
    });
  }

  // Called by the host when the page replies.
  _settle(result) {
    const p = this._pending; this._pending = null;
    this._emit({ type: 'hide' });
    if (p) { clearTimeout(p.timer); try { p.resolve(result); } catch (e) {} }
  }

  reset() { this._emit({ type: 'reset' }); }
}

export const fbBus = new FbBus();

// ── The mounted host ───────────────────────────────────────────────────────
export default function FirebasePhoneHost() {
  // Web has a real DOM — services/firebasePhone.web.js handles it inline, no
  // WebView needed. Render nothing here.
  if (Platform.OS === 'web') return null;

  // Loaded lazily so the WebView dep isn't pulled into the web bundle.
  const WebViewRef = useRef(null);
  const [WebViewComp, setWebViewComp] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const webRef = useRef(null);
  const readyRef = useRef(false);
  const queuedRef = useRef(null); // a send fn waiting for the page's 'ready'

  useEffect(() => {
    let alive = true;
    try {
      // eslint-disable-next-line global-require
      const mod = require('react-native-webview');
      if (alive) setWebViewComp(() => (mod.WebView || mod.default));
    } catch (e) { /* WebView missing — firebasePhoneAvailable() will see null */ }
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const unsub = fbBus.subscribe((a) => {
      if (a.type === 'run') {
        setMounted(true);
        if (a.show) setVisible(true);
        const send = () => { try { webRef.current && webRef.current.postMessage(JSON.stringify(a.cmd)); } catch (e) {} };
        if (readyRef.current) send();
        else queuedRef.current = send;
      } else if (a.type === 'hide') {
        setVisible(false);
      } else if (a.type === 'reset') {
        readyRef.current = false;
        queuedRef.current = null;
        setVisible(false);
        setMounted(false);
      }
    });
    return unsub;
  }, []);

  const onMessage = (e) => {
    let d;
    try { d = JSON.parse(e.nativeEvent.data); } catch (err) { return; }
    if (!d || !d.ev) return;
    if (d.ev === 'ready') {
      readyRef.current = true;
      if (queuedRef.current) { const fn = queuedRef.current; queuedRef.current = null; fn(); }
      return;
    }
    if (d.ev === 'sent' || d.ev === 'token' || d.ev === 'error') {
      fbBus._settle(d);
    }
  };

  if (!mounted || !WebViewComp) return null;
  const WV = WebViewComp;

  return (
    <View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFill, { zIndex: visible ? 9999 : -1, opacity: visible ? 1 : 0 }]}
    >
      {visible ? (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.overlayText}>Verificando número…</Text>
        </View>
      ) : null}
      <WV
        ref={webRef}
        source={{ uri: PAGE_URL }}
        onMessage={onMessage}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        startInLoadingState={false}
        style={styles.web}
        // Keep the WebView itself transparent; the overlay above provides the
        // "verificando" UI. The reCAPTCHA challenge (rare) renders inside.
        containerStyle={{ backgroundColor: 'transparent' }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: 'transparent' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,8,12,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  overlayText: { color: '#fff', marginTop: 16, fontSize: 15, fontWeight: '600' },
});
