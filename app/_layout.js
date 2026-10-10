// Hermes/iOS quirk: native promise rejections from expo-modules-core (e.g.
// when a JSI host function declared with arity 2 is invoked through
// babel's wrapped CodedError chain with 3 args) surface as
// "Uncaught (in promise) Error: Received N arguments, but M was expected"
// toasts even though the JS path itself is fine — the error message is
// purely from a native arity check. They flood LogBox in dev and Sentry
// in prod.
//
// On iOS Hermes, expo-router's metro-runtime wires `HermesInternal
// .enablePromiseRejectionTracker` directly into ExceptionsManager, bypassing
// the JS `promise/setimmediate/rejection-tracking` polyfill entirely. So we
// re-call it with our own onUnhandled to filter the noise. (On Android /
// the JS-promise path we still patch the polyfill below as a fallback.)
const __chatyy_NOISY_REJECTION_RE = /Received \d+ arguments?, but \d+ was expected/;
function __chatyy_installRejectionFilter() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : null);
    const Hermes = g && g.HermesInternal;
    if (Hermes && typeof Hermes.enablePromiseRejectionTracker === 'function') {
      Hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id, rejection) => {
          const msg = rejection && rejection.message ? rejection.message : String(rejection || '');
          if (__chatyy_NOISY_REJECTION_RE.test(msg)) return;
          if (typeof console !== 'undefined' && console.warn) {
            console.warn(`Possible Unhandled Promise Rejection (id: ${id}):`, msg);
          }
        },
        onHandled: () => {},
      });
    }
  } catch {}
  try {
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (id, err) => {
        const msg = err && err.message ? err.message : String(err || '');
        if (__chatyy_NOISY_REJECTION_RE.test(msg)) return;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`Possible Unhandled Promise Rejection (id: ${id}):`, msg);
        }
      },
      onHandled: () => {},
    });
  } catch {}
}
__chatyy_installRejectionFilter();
// Re-install after expo-router/metro-runtime registers its own tracker
// during bootstrap — Hermes' enablePromiseRejectionTracker overwrites the
// last caller's callbacks, so our second call wins.
if (typeof setTimeout === 'function') {
  setTimeout(__chatyy_installRejectionFilter, 0);
  setTimeout(__chatyy_installRejectionFilter, 1500);
}

// Belt-and-suspenders: monkey-patch ExceptionsManager.handleException so the
// noisy rejections are filtered even if both Hermes and JS-polyfill trackers
// got registered before us. metro-runtime calls
// `ExceptionsManager.handleException(rejectionError)` directly, so this is
// the last-chance choke point.
try {
  const ExceptionsManager = require('react-native/Libraries/Core/ExceptionsManager');
  if (ExceptionsManager && !ExceptionsManager.__chatyy_patched) {
    const _origHandle = ExceptionsManager.handleException;
    ExceptionsManager.handleException = function (e, isFatal) {
      try {
        const msg = (e && (e.message || (typeof e === 'string' ? e : ''))) || '';
        if (!isFatal && /Received \d+ arguments?, but \d+ was expected/.test(String(msg))) {
          return;
        }
      } catch {}
      return _origHandle.apply(this, arguments);
    };
    ExceptionsManager.__chatyy_patched = true;
  }
} catch {}

// ⚠️ MUST be the FIRST import — globally neutralizes legacy LayoutAnimation on
// iOS (Fabric + LayoutAnimation segfault, EXC_BAD_ACCESS at 0x18). Imported
// before React/components so the monkey-patch is installed before any screen
// mounts and schedules a LayoutAnimation. Android is left untouched.
import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import '../services/disableLayoutAnimationIOS';
// [2026-10-07 coldstart] Boot trace + native-splash owner + after-first-paint
// scheduler. Imported this early so its T0 is as close to bundle start as
// possible (imports evaluate in order).
import { mark as _bootMark, armSplashFallback, afterFirstPaint, reportBootMarksSampled } from '../services/bootTrace';
// Suspende a renderização de telas empilhadas fora de tela → menos trabalho no
// thread JS e menos memória (react-native-screens já está no bundle nativo).
import { enableFreeze } from 'react-native-screens';
try { enableFreeze(true); } catch {}
import React, { Suspense } from "react";
import { Platform, View as RNView, Text as RNText, Linking, Alert, Animated as _RNAnimated, InteractionManager, useColorScheme as _useColorScheme } from 'react-native';
// ─── Sentry crash reporting ───
import { initSentry } from '../services/sentry';
import { installCrashReporter, reportStep, setReporterIdentity } from '../services/crashReporter';
import { BASE_URL } from '../services/api';

// Install crash reporter FIRST — before any other boot work that can throw.
// Observed 2026-05-18: LiveKit registerGlobals at boot was throwing on
// some devices, the throw escaped the outer try/catch via a JSI bridge
// path, and expo-updates' ErrorRecovery saw a failed boot, rolled back,
// re-crashed → SIGABRT loop. Reporter must be live before that runs so
// the failure POSTs to push_diag instead of disappearing.
try { installCrashReporter(); } catch {}

// LiveKit RN: registra RTCPeerConnection/MediaStream/navigator.mediaDevices
// no globalThis. Tem que rodar ANTES de qualquer import de livekit-client
// ou @livekit/react-native. Native-only — web já tem WebRTC do browser.
//
// [bug 2026-05-15 #8] iOS: pass `autoConfigureAudioSession: false` so the
// LiveKit native bridge does NOT issue its own AVAudioSession setCategory/
// setActive whenever a track is published. CallKit owns the session on
// iOS via the AppDelegate + ExpoCallKitModule path; letting LiveKit poke
// the session in parallel produced competing setCategory paths and the
// "uplink mic silent for the first second" / "speaker stuck" regressions.
// `setupIOSAudioManagement` is the lower-level escape hatch: we tell LK
// the session is hot ALREADY and configured for voice; LK will skip its
// own configuration entirely.
//
// [cold-start, 2026-05-26] `require('@livekit/react-native')` synchronously
// pulls in the whole WebRTC JS bridge + native global registration — pure
// dead weight on the launch→chat-list path since calls are lazy (CallContext
// + /call screen are React.lazy and never mount at boot). Deferred off the
// critical path with setTimeout(0): registration still completes long before
// any call can connect (the call screen + livekit-client import are gated
// behind a user/CallKit action that's seconds away at minimum), but the
// require() no longer blocks first paint. Idempotent — guarded so it runs once.
let _lkGlobalsRegistered = false;
function _registerLiveKitGlobals() {
  if (_lkGlobalsRegistered || Platform.OS === 'web') return;
  _lkGlobalsRegistered = true;
  try {
    const lkrn = require('@livekit/react-native');
    if (typeof lkrn.registerGlobals === 'function') {
      try { lkrn.registerGlobals({ autoConfigureAudioSession: false }); }
      catch (e) {
        try { reportStep('lk_register_globals_v2_fail', e?.message); } catch {}
        try { lkrn.registerGlobals(); }
        catch (e2) { try { reportStep('lk_register_globals_v1_fail', e2?.message); } catch {} }
      }
    }
    if (Platform.OS === 'ios' && typeof lkrn.setupIOSAudioManagement === 'function') {
      try { lkrn.setupIOSAudioManagement({ defaultOutput: 'earpiece' }); }
      catch (e) { try { reportStep('lk_setup_audio_fail', e?.message); } catch {} }
    }
  } catch (e) {
    try { reportStep('lk_require_fail', e?.message); } catch {}
    if (typeof console !== 'undefined') console.warn('[LiveKit] registerGlobals failed:', e?.message);
  }
}
// [2026-10-07 coldstart] setTimeout(0) still ran the 80-200 ms require +
// registerGlobals on the JS thread BEFORE the first frames (timers fire while
// the root is mounting). Now: after the chat list's first paint (+1.2 s,
// staggered behind the critical post-paint work). Any call path that needs
// WebRTC globals earlier (call launched from a push / CallKit within the first
// second) calls globalThis.__chatyyEnsureLiveKitGlobals() synchronously first
// (app/call.js ensureLiveKitRegistered, services/pstnCall.js) — so the
// registration ORDER is unchanged: this opts-registration always runs before
// the screen's own registerGlobals(), exactly as when it ran at boot.
try { if (typeof globalThis !== 'undefined') globalThis.__chatyyEnsureLiveKitGlobals = _registerLiveKitGlobals; } catch {}
if (Platform.OS !== 'web' && typeof setTimeout === 'function') {
  afterFirstPaint(_registerLiveKitGlobals, 1200);
}

// Web has no native Animated module — force useNativeDriver:false globally
// so every animation across the app stops spamming "RCTAnimation missing"
// warnings. Patch once at entry before any component imports Animated.
if (Platform.OS === 'web' && _RNAnimated && !_RNAnimated.__WEB_PATCHED) {
  const origTiming = _RNAnimated.timing;
  const origSpring = _RNAnimated.spring;
  const origDecay = _RNAnimated.decay;
  const forceJs = (cfg) => (cfg && cfg.useNativeDriver ? { ...cfg, useNativeDriver: false } : cfg);
  _RNAnimated.timing = (v, cfg) => origTiming(v, forceJs(cfg));
  _RNAnimated.spring = (v, cfg) => origSpring(v, forceJs(cfg));
  _RNAnimated.decay = (v, cfg) => origDecay(v, forceJs(cfg));
  _RNAnimated.__WEB_PATCHED = true;
}

// [2026-06-09 sweep] RN-web's Alert.alert is a pure no-op (`static alert() {}`):
// it never throws and renders nothing, so every confirmation dialog built on it
// (~480 call sites) silently did nothing in the browser — deletes, blocks,
// leave-group, clear-chat all dead on web. services/alerts.js#safeAlert fixed
// the 5 files that import it; this global patch covers the rest in one place.
// Web-only: native Alert.alert is untouched. Same button mapping as safeAlert
// (style:'cancel' → Cancel side of window.confirm; first non-cancel onPress
// runs on OK; ≤1 button → window.alert).
if (Platform.OS === 'web' && Alert && !Alert.__CHATYY_WEB_PATCHED) {
  Alert.alert = function (title, message, buttons) {
    if (typeof window === 'undefined') return;
    const text = (title ? String(title) + (message ? '\n\n' + String(message) : '') : String(message || '')) || '';
    if (!buttons || !Array.isArray(buttons) || buttons.length <= 1) {
      try { window.alert(text); } catch {}
      const onlyBtn = Array.isArray(buttons) ? buttons[0] : null;
      if (onlyBtn?.onPress) try { onlyBtn.onPress(); } catch {}
      return;
    }
    let ok = true;
    try { ok = window.confirm(text); } catch {}
    const cancel = buttons.find(b => b?.style === 'cancel');
    const proceed = buttons.find(b => b?.style !== 'cancel');
    const target = ok ? proceed : cancel;
    if (target?.onPress) try { target.onPress(); } catch {}
  };
  Alert.__CHATYY_WEB_PATCHED = true;
}
let GestureHandlerRootView;
if (Platform.OS !== 'web') {
  try { GestureHandlerRootView = require('react-native-gesture-handler').GestureHandlerRootView; } catch {}
}
if (!GestureHandlerRootView) GestureHandlerRootView = ({ children, style }) => React.createElement(RNView, { style }, children);

// [2026-10-09] Compartilhar da galeria abria /share-receive 2x: o deep link
// (onemundomail://?dataUrl=…, sem params), o getShareIntent() e o
// ShareIntentWatcher disparavam cada um a sua navegação. Um portão único:
// a 1ª abre; uma vazia seguida de uma com conteúdo SUBSTITUI (replace);
// duplicatas com conteúdo dentro de 5s são ignoradas.
let _shareNavAt = 0;
let _shareNavHadParams = false;
function _openShareReceive(router, params) {
  const has = !!(params && Object.keys(params).length);
  const now = Date.now();
  const recent = now - _shareNavAt < 5000;
  if (recent && (_shareNavHadParams || !has)) return;
  const replaceEmpty = recent && !_shareNavHadParams && has;
  _shareNavAt = now;
  _shareNavHadParams = has;
  try {
    if (!has) router.replace('/share-receive');
    else if (replaceEmpty) router.replace({ pathname: '/share-receive', params });
    else router.push({ pathname: '/share-receive', params });
  } catch {}
}

// [2026-10-08 share-sheet] Every shared file (up to 10) as a JSON route param,
// so /share-receive can show all thumbnails with their real aspect ratio
// (expo-share-intent reports width/height) and send the whole batch.
function _shareFilesParam(files) {
  try {
    const list = (Array.isArray(files) ? files : []).filter(f => f && f.path).slice(0, 10).map(f => {
      const mime = String(f.mimeType || '');
      return {
        uri: f.path,
        mime,
        name: _sanitizeShareName(f.fileName, f.path, mime),
        kind: mime.startsWith('video') ? 'video' : mime.startsWith('image') ? 'image' : 'file',
        w: Number(f.width) || 0,
        h: Number(f.height) || 0,
        size: Number(f.size) || 0,
      };
    });
    return list.length ? JSON.stringify(list) : '';
  } catch { return ''; }
}

// Sanitizes filenames coming from the iOS share-intent / Files-app pipeline.
// expo-share-intent has been observed to surface the literal "$value" as
// fileName on certain iOS versions (Files-app PDFs especially) — Swift's
// SwiftUI binding placeholder leaking out as a string. Without this, both
// the chat bubble and the R2 key end up with "$value.pdf" in them.
function _sanitizeShareName(rawName, path, mimeType) {
  const bad = /^\s*\$value(\.|$)|^\s*\$\{?value\}?\b/i;
  let name = (rawName || '').trim();
  if (!name || bad.test(name)) {
    // Try to derive from the URI's basename
    const base = (path || '').split(/[\\/]/).pop() || '';
    if (base && !bad.test(base)) {
      name = decodeURIComponent(base);
    } else {
      // Last resort: synthesize from MIME
      const extByMime = (m) => {
        if (!m) return '';
        if (m === 'application/pdf') return 'pdf';
        if (m.startsWith('image/')) return m.split('/')[1].replace('jpeg','jpg');
        if (m.startsWith('video/')) return m.split('/')[1] === 'quicktime' ? 'mov' : m.split('/')[1];
        if (m.startsWith('audio/')) return m.split('/')[1] === 'mp4' ? 'm4a' : m.split('/')[1];
        return '';
      };
      const ext = extByMime(mimeType);
      name = `arquivo_${Date.now()}${ext ? '.' + ext : ''}`;
    }
  }
  return name;
}

// Deferred initialization — called once from useEffect in AppInit to avoid
// global side-effects at import time (HIGH severity audit finding).
let _globalInitDone = false;
function initGlobalErrorHandlers() {
  if (_globalInitDone) return;
  _globalInitDone = true;

  initSentry();

  // Re-install the rejection filter (covers RN re-enabling tracking during
  // InitializeCore after our top-of-file install). Idempotent.
  try {
    const tracking = require('promise/setimmediate/rejection-tracking');
    const NOISY_RE = /Received \d+ arguments?, but \d+ was expected/;
    tracking.enable({
      allRejections: true,
      onUnhandled: (id, err) => {
        const msg = err && err.message ? err.message : String(err || '');
        if (NOISY_RE.test(msg)) return;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`Possible Unhandled Promise Rejection (id: ${id}):`, msg);
        }
      },
      onHandled: () => {},
    });
  } catch {}

  // Global crash reporter — catches fatal errors before app closes
  if (typeof ErrorUtils !== 'undefined') {
    const _prev = ErrorUtils.getGlobalHandler();
    // [2026-10-06] Dedupe: a render loop re-throwing the same error used to
    // POST once per frame. Same (message + top frame) → one line per 60s.
    const _recentSig = Object.create(null);
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      try {
        const msg = error?.message || String(error);
        const stack = error?.stack || '';
        const sig = `${String(msg).slice(0, 80)}|${String(stack).split('\n').slice(1, 2).join('').slice(0, 60)}`;
        const now = Date.now();
        if (_recentSig[sig] && now - _recentSig[sig] < 60000) {
          if (_prev) _prev(error, isFatal);
          return;
        }
        _recentSig[sig] = now;
        // Context (app version, OTA id, OS, device, heap, breadcrumbs) comes
        // from the crash reporter so both sinks (crashes/*.log here and
        // push_diag per-device) describe the same build.
        let ctx = {};
        try { ctx = require('../services/crashReporter').getCrashContext?.() || {}; } catch {}
        // Send crash report to server (telemetry only)
        fetch(`${BASE_URL}/api/email.php?action=crash_report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `${msg}`.slice(0, 400),
            stack: stack.substring(0, 2000),
            // `component` is the third column in crashes/*.log — carry the
            // context there so a grep on the log shows ver/ota/os per crash.
            component: `ctx: ${Object.keys(ctx).map(k => `${k}=${ctx[k]}`).join(' ')}`,
            fatal: isFatal,
            platform: Platform.OS,
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => {});
        // NO Alert.alert() here — iOS 26 has a UIAlertController init bug
        // (_UIAlertControllerTextFieldViewController loadView crashes on
        // some devices/sim) that turns a caught fatal into a HARD native
        // crash of the whole app. Since the real error was already handled
        // by the upstream ErrorBoundary / Sentry / telemetry fetch above,
        // there's no benefit to showing an alert here. Stay silent.
      } catch (e) {}
      // Call previous handler
      if (_prev) _prev(error, isFatal);
    });
  }
}
// ─── End crash reporter ───

import { useEffect, useRef, useState, useCallback } from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../services/queryClient';
import { AuthProvider, useAuth, wasExplicitLogoutRecently } from '../context/AuthContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { useReducedMotion } from '../components/reducedMotion'; // [2026-10-04] honor OS Reduce Motion in nav
import ChildRestrictionGuard from '../components/ChildRestrictionGuard';
import { nativeSheetScreenOptions } from '../components/NativeSheet'; // [2026-10-09 native-sheets] formSheet nativo (rota-ponte /native-sheet)
import { MailProvider } from '../context/MailContext';
import { ThemeProvider } from '../context/ThemeContext';
import { LanguageProvider, useLanguage, preloadBootLanguage, bootLanguageNeedsPreload } from '../context/LanguageContext';
import { CurrencyProvider } from '../context/CurrencyContext';
import { BiometricProvider } from '../context/BiometricContext';
import { PhotosProvider } from '../context/PhotosContext';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// [2026-10-06 keyboard-controller] Root KeyboardProvider (native only; web =
// passthrough via utils/threadKeyboard.js). Mounted disabled — the chat thread
// switches it on while mounted. See utils/threadKeyboard.native.js.
import { ChatyyKeyboardProvider } from '../utils/threadKeyboard';
import ErrorBoundary from '../components/ErrorBoundary';
import OfflineNotice from '../components/OfflineNotice';
import NotificationToast from '../components/NotificationToast';
import { CallProvider } from '../context/CallContext';
import CallStatusBar from '../components/CallStatusBar';
// [2026-10-07 voice-native] global voice-note mini player (leaves the chat → keeps playing)
import VoiceMiniPlayer from '../components/chat/VoiceMiniPlayer';
import EmailUndoBar from '../components/EmailUndoBar';

// Lazy-load call components to break circular dependency
const IncomingCallListener = React.lazy(() => import('../components/IncomingCallListener'));
const LiveLocationPingListener = React.lazy(() => import('../components/LiveLocationPingListener'));
const LiveLocationHeartbeat = React.lazy(() => import('../components/LiveLocationHeartbeat'));
// Hidden WebView host that runs Firebase Phone Auth (Google sends the OTP SMS).
const FirebasePhoneHost = React.lazy(() => import('../components/FirebasePhoneHost'));
// [decline-with-message iOS, 2026-05-17] CallKit can't carry custom buttons,
// so we surface a JS sheet right after the system decline action fires.
// The Android equivalent is inline in IncomingCallActivity.kt.
const DeclineWithMessageSheet = React.lazy(() => import('../components/DeclineWithMessageSheet'));
const ActiveCallBar = React.lazy(() => import('../components/ActiveCallBar').then(m => ({ default: () => { const B = m.ActiveCallBridge; return React.createElement(B, null); } })));
// Cold-start: these are modal/overlay surfaces that are never visible at
// launch (they only mount UI when triggered by a WS event / permission flow).
// Lazy-loading them keeps their module code (and transitive deps) out of the
// synchronous launch→chat-list bundle path. Each is rendered under a
// <Suspense fallback={null}> below, so the deferred chunk resolving later has
// no visible effect — until then they'd render null anyway.
const LoginChallengePrompt = React.lazy(() => import('../components/LoginChallengePrompt'));
const LocationRequestModal = React.lazy(() => import('../components/LocationRequestModal'));
const PushLoginRequestModal = React.lazy(() => import('../components/PushLoginRequestModal'));
const PWAPrompts = React.lazy(() => import('../components/PWAPrompts'));
// [2026-10-09 lighter-app] WhatsNewSheet só é avaliado quando o gate decide
// mostrar (1x por upgrade) — fora do caminho de boot. Retorna null invisível.
const _whatsNew = () => require('../components/WhatsNewSheet');
const shouldShowWhatsNew = (...a) => _whatsNew().shouldShowWhatsNew(...a);
// Stage 6 — surface "Phone offline" UI when web's relay reads fall back to
// IndexedDB cache. Web-only; renders null on native.
import PhoneOfflineBanner from '../components/PhoneOfflineBanner';
// 2026-05-18 — surface push-token registration failures so the user can
// tap-to-retry instead of going dark on incoming calls when their token
// silently drops. Native-only; renders null on web.
import PushTokenStaleBanner from '../components/PushTokenStaleBanner';
import PushPermissionPrimer from '../components/PushPermissionPrimer'; // [2026-10-07 native-polish]
import { registerBackgroundSync } from '../services/backgroundSync';
// [2026-10-08 receipts-speed] Side-effect: define+registra a task de push em 2º
// plano que manda o ✓✓ cinza (chat_push_delivered com o d_ack do push) — cobre
// binários antigos sem device-ack nativo. Precisa ser top-level (headless).
import '../services/pushDeliveryTask';
// Side-effect import — patches expo-audio RecordingPresets.HIGH_QUALITY to
// the WhatsApp Opus profile (32kbps mono 16/22kHz) before any chat screen
// reads it. Mutates the live preset object so chat-conversation's inline
// `RecordingPresets.HIGH_QUALITY` reference picks it up on the next record.
import '../services/voiceRecorderTuning';
import { initAutoBackup } from '../services/autoBackup';
import { trackPageview, trackAppOpen } from '../services/analytics';
import { prefetch, warmCache } from '../services/cache';
import { useTheme } from '../context/ThemeContext';

function PWAPromptsThemed() {
  const { colors, isDark } = useTheme();
  // Translation context isn't crucial here — PWAPrompts has hardcoded
  // fallbacks; we just pass null t (component handles undefined).
  return <PWAPrompts colors={colors} isDark={isDark} t={null} />;
}

function ThemedStatusBar() {
  const { isDark, colors } = useTheme();
  // Android nao respeita `style` sozinho — precisa backgroundColor explicito
  // pra status bar nao ficar branca opaca em modais/login (audit 2026-05-05).
  // `translucent` permite que o conteudo flua atras (status bar como overlay)
  // — a maioria das nossas telas ja usa SafeAreaView/insets, entao funciona.
  return (
    <StatusBar
      style={isDark ? 'light' : 'dark'}
      backgroundColor={isDark ? (colors?.background || '#000000') : '#ffffff'}
      translucent={Platform.OS === 'android'}
    />
  );
}

// Keep the native splash screen visible until our AnimatedSplash component is mounted and ready.
// This prevents any flash of white/icon between the native splash hiding and React rendering.
SplashScreen.preventAutoHideAsync().catch(() => {});
// [2026-10-09 lighter-app] Começa a ler o idioma salvo (+ pacote em disco) já na
// avaliação do módulo, em paralelo à hidratação do cache; o gate só aguarda.
try { if (Platform.OS !== 'web') preloadBootLanguage(900); } catch {}

// Initialize native services — deferred off the cold-start path. Background
// sync task registration touches expo-task-manager/BackgroundFetch native
// bridges and is irrelevant to first paint; running it at module-eval time
// added native bridge work before the first screen could render. setTimeout(0)
// lets the launch→chat-list path finish first; registration is idempotent.
// [2026-10-07 coldstart] setTimeout(0) still landed inside the first-frame
// window; now after the chat list's first paint (+1.5 s, idempotent).
if (Platform.OS !== 'web' && typeof setTimeout === 'function') {
  afterFirstPaint(() => { try { registerBackgroundSync().catch(() => {}); } catch {} }, 1500);
  // [2026-10-07 bgsync] Background message journal: foreground merge hook now
  // (cheap listener; the cold-start merge itself runs inside the chat list's
  // first store read — services/chatStore getConversationsSync), periodic
  // native bg sync (Android WorkManager / iOS BGAppRefreshTask) + its cursor
  // snapshot after the first paint. All no-ops on binaries without the natives.
  try { require('../services/bgJournal').init(); } catch {}
  afterFirstPaint(() => {
    try {
      const bj = require('../services/bgJournal');
      bj.scheduleBackgroundSync(true);
      bj.exportSyncConfig();
    } catch {}
  }, 2500);
  // [2026-10-07 native-core] Phase 1 shadow native socket. init() returns on
  // its first line while NATIVE_CORE_ENABLED is false and the test allowlist
  // is empty (default) — nothing else runs.
  afterFirstPaint(() => { try { require('../services/nativeCore').init(); } catch {} }, 4000);
}
// [2026-10-09 open-instant] Foreground catch-up (AppState 'active' → one
// immediate chat_sync for push-touched/unread conversations, outside the
// debounced sync queue). Cheap listener; web + native.
try { require('../services/chatOpenPrefetch').init(); } catch {}

// Handles deep links: mailto:, chat, email, and other app URLs
function useDeepLinking() {
  const router = useRouter();

  const handleUrl = useCallback((url) => {
    if (!url) return;
    // Diagnostic beacon so we see exactly what URL iOS hands us on share.
    try {
      fetch('https://chatyy.com.br/api/email.php?action=crash_report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '[DEEP_LINK]',
          stack: String(url).substring(0, 500),
          component: 'handleUrl-layout',
          fatal: false,
        }),
      }).catch(() => {});
    } catch {}
    try {
      // mailto: links → compose screen
      const mailtoMatch = url.match(/(mailto:[^)]*)/i) || (url.startsWith('mailto:') ? [url, url] : null);
      if (mailtoMatch) {
        router.push('/compose?mailto=' + encodeURIComponent(mailtoMatch[1]));
        return;
      }

      // Parse chatyy.com.br deep links and onemundomail:// scheme
      // Patterns: chatyy.com.br/chat/123, chatyy.com.br/email/456
      let pathname = null;
      try {
        if (url.includes('chatyy.com.br') || url.includes('mail.onemundo.com.br')) {
          const parsed = new URL(url);
          pathname = parsed.pathname;
        } else if (url.startsWith('onemundomail://')) {
          pathname = '/' + url.replace('onemundomail://', '').split('?')[0];
        }
      } catch {}

      if (!pathname) return;

      // [2026-10-09 universal-links] https links that app/+native-intent.js
      // already rewrote for expo-router (/u, /j, /g, /ch, /live, /feed, /meet,
      // /call, /stickers) — navigating here too would stack a 2nd copy.
      try {
        const _ul = require('../utils/universalLinks').resolveUniversalLink(url);
        if (_ul && _ul.owner === 'router') return;
      } catch {}

      // /chat/:id → open chat conversation
      const chatMatch = pathname.match(/^\/chat\/(\d+)/);
      if (chatMatch) {
        // Shared helper: replace (not stack) when a chat is already open.
        try { require('../services/pushNotifications').openConversation('/chat-conversation?id=' + chatMatch[1], chatMatch[1]); }
        catch { router.push('/chat-conversation?id=' + chatMatch[1]); }
        return;
      }

      // /email/:id → open email
      const emailMatch = pathname.match(/^\/email\/(\d+)/);
      if (emailMatch) {
        router.push('/read?uid=' + emailMatch[1]);
        return;
      }

      // /meet/:id → open meeting room
      const meetMatch = pathname.match(/^\/meet\/([a-zA-Z0-9_-]+)/);
      if (meetMatch) {
        router.push('/meet/' + meetMatch[1]);
        return;
      }

      // /feed/:id → public post share. Works unauth'd — the feed/[id]
      // screen fetches via feed_get_post (no bearer required). Without
      // this match, the app fell through the auth gate and bounced to
      // /login, defeating the whole point of a shareable link.
      const feedMatch = pathname.match(/^\/feed\/(\d+)/);
      if (feedMatch) {
        router.push('/feed/' + feedMatch[1]);
        return;
      }

      // /stickers/store?install=<handle> → sticker pack share link.
      // Auto-opens the install modal for the pack referenced by the handle.
      // The handle is the share slug minted by sticker_pack_create.
      if (pathname === '/stickers/store' || pathname === '/stickers' || pathname.startsWith('/stickers/store')) {
        let installParam = '';
        try {
          const parsed = new URL(url);
          installParam = parsed.searchParams.get('install') || '';
        } catch {}
        if (installParam) {
          router.push('/stickers/store?install=' + encodeURIComponent(installParam));
        } else {
          router.push('/stickers/store');
        }
        return;
      }

      // /j/:token → join group via invite link
      const joinMatch = pathname.match(/^\/j\/([a-f0-9]{32})$/);
      if (joinMatch) {
        // Never auto-join from a link: open the preview screen, whose Join
        // button is the only thing that joins (logged-out users are bounced
        // to /login?next=/j/<token> by the auth gate, preserving the link).
        router.push('/j/' + joinMatch[1]);
        return;
      }

      // share:// or /share → iOS share sheet opens the app with a custom
      // scheme path that doesn't match any Stack.Screen, showing "Unmatched
      // Route". Forward to /share-receive (which IS registered) so the
      // share-from-gallery flow lands on the picker instead of an error.
      if (pathname === '/share' || pathname.startsWith('/share?') || pathname.startsWith('/share/')) {
        _openShareReceive(router);
        return;
      }
      // iOS Share Extension pattern: `onemundomail://?dataUrl=onemundomailShareKey`.
      // pathname collapses to `/` (no host/path on the custom scheme), so the
      // /share matcher above misses it. Detect the `dataUrl=` query flag and
      // route the same way.
      if (url.includes('dataUrl=') || url.includes('shareKey') || url.includes('ShareKey')) {
        _openShareReceive(router);
        return;
      }
      // Any unmatched onemundomail:// that opened the app from an external
      // share/action — land on /share-receive rather than Unmatched Route.
      if (url.startsWith('onemundomail://') && (pathname === '/' || pathname === '')) {
        _openShareReceive(router);
        return;
      }
    } catch {}
  }, [router]);

  useEffect(() => {
    // Web: check URL hash/search params on load for deep link routing
    if (Platform.OS === 'web') {
      try {
        const hash = window.location.hash;
        if (hash && hash.length > 1) {
          const path = hash.substring(1); // remove #
          const chatMatch = path.match(/^\/chat\/(\d+)/);
          if (chatMatch) {
            setTimeout(() => { try { require('../services/pushNotifications').openConversation('/chat-conversation?id=' + chatMatch[1], chatMatch[1]); } catch { router.push('/chat-conversation?id=' + chatMatch[1]); } }, 500);
          }
          const emailMatch = path.match(/^\/email\/(\d+)/);
          if (emailMatch) {
            setTimeout(() => router.push('/read?uid=' + emailMatch[1]), 500);
          }
        }
      } catch {}
      return;
    }

    // Native: handle cold-start and warm-start URLs
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    }).catch(() => {});

    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleUrl(url);
    });

    // [2026-10-08 android-otp-shortcuts] iOS home-screen quick actions (static
    // + recent conversations). Android shortcuts are plain deep links (above).
    let unsubShortcuts = () => {};
    try {
      unsubShortcuts = require('../services/appShortcuts').initShortcutLaunchHandling((href) => {
        const m = href.match(/^\/chat-conversation\?(?:.*&)?id=([^&]+)/);
        if (m) {
          try { require('../services/pushNotifications').openConversation(href, decodeURIComponent(m[1])); return; } catch {}
        }
        router.push(href);
      });
    } catch {}

    return () => { sub.remove(); try { unsubShortcuts(); } catch {} };
  }, [handleUrl]);
}

function AppInit({ onNotification, setOtaToast }) {
  const cleanupRef = useRef(null);
  const pathname = usePathname();
  const pathnameRef = useRef(null);
  const prefetchedRef = useRef(false);
  useDeepLinking();

  // Deep-link auth gate: if an unauthenticated user opens a protected URL
  // directly (e.g., copy/paste chat-conversation?id=X in a fresh browser
  // with no session), bounce them to /login with `?next=` so we can come
  // back to the original URL after they sign in. Public routes stay open.
  const auth = useAuth();
  const authUser = auth?.user;
  const authLoading = auth?.loading;
  const router = useRouter();
  // Let the push-tap handler switch to the account a push was addressed to.
  const _switchAcct = auth?.switchAccount;
  useEffect(() => {
    try {
      require('../services/pushNotifications').setSwitchAccountHandler(_switchAcct ? (e) => _switchAcct(e) : null);
    } catch {}
  }, [_switchAcct]);
  useEffect(() => {
    const PUBLIC_ROUTES = ['/login', '/signup', '/signup-phone', '/signup-username', '/forgot', '/verify-phone-required', '/onboarding', '/privacy', '/feed'];
    if (authLoading) return;
    if (authUser) return;
    if (!pathname || pathname === '/' || pathname === '') return;
    if (PUBLIC_ROUTES.some(p => pathname === p || pathname.startsWith(p + '/'))) return;
    // [2026-10-06 founder: 'Sair não vai pro login' (Android)] Logout EXPLÍCITO
    // → /login limpo. Este efeito é a fonte única de verdade pós-logout: roda
    // quando `user` vira null em qualquer rota protegida, mesmo que o
    // router.replace disparado de dentro do ProfileSettingsSheet (Modal em
    // desmontagem) tenha sido engolido. Sem `?next=`: voltar depois do login
    // para /u/<email-da-conta-antiga> seria errado.
    if (wasExplicitLogoutRecently()) { router.replace('/login'); return; }
    let nextUrl = pathname;
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        nextUrl = window.location.pathname + window.location.search;
      }
    } catch {}
    router.replace('/login?next=' + encodeURIComponent(nextUrl));
  }, [pathname, authUser, authLoading, router]);

  // ─── OTA update check with visible progress toast ───
  // Previously silent — if the check failed or took long, the user had no
  // way to know if they were on the latest JS. Now we surface 3 phases:
  //   1. "Buscando atualização..."  (checkForUpdateAsync)
  //   2. "Baixando..."              (fetchUpdateAsync)
  //   3. "Atualizando agora..."     → reloadAsync in 1s
  // On "no update available" we briefly say so then auto-dismiss.
  // OTA toast state/JSX was moved up to RootLayout — kept here only the
  // check effect, which calls setOtaToast passed in via props.
  const otaToastTimer = useRef(null);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (typeof setOtaToast !== 'function') return;
    (async () => {
      try {
        const Updates = require('expo-updates');
        if (!Updates?.checkForUpdateAsync) return;
        // Only surface the toast when there IS work to do (downloading,
        // applying). Silent on "already up to date" and on check errors —
        // user found those noisy and not useful.
        const update = await Updates.checkForUpdateAsync();
        if (!update.isAvailable) return;
        setOtaToast({ text: 'Baixando atualização…', kind: 'info' });
        await Updates.fetchUpdateAsync();
        // [2026-10-04] Em vez de recarregar sozinho (invasivo + histórico de
        // "updates empilhados"), mostra um banner PERSISTENTE e TOCÁVEL: o
        // usuário VÊ que a nova versão chegou e aplica quando quiser.
        setOtaToast({
          text: 'Nova versão disponível',
          kind: 'update',
          onPress: () => { try { Updates.reloadAsync(); } catch {} },
        });
      } catch (e) {}
    })();
    return () => { if (otaToastTimer.current) clearTimeout(otaToastTimer.current); };
  }, [setOtaToast]);

  // [2026-05-25] iOS answer → open the rich /call.js. The native CallKit answer
  // presents an INSTANT native screen (the reliable "floor", incl. cold-start);
  // here we wire the LIVE listener that navigates to the pretty /call.js, which
  // adopts the pre-connected room and then dismisses the native screen
  // (ExpoCallKit.dismissNativeCallVC, seamless handoff). This is the missing
  // piece: IncomingCallListener's own onCallAnswered→push is gated OFF on mobile
  // (returns null), so the JS call screen never opened on answer. Surgical +
  // isolated — does NOT enable the 1900-line web listener. Caller side is
  // unaffected (it navigates via chat-conversation; the module's onCallAnswered
  // only fires on the device that ANSWERED).
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let lastNavCallId = null;
    let lastNavAt = 0;
    let unsub = () => {};
    try {
      const ExpoCallKit = require('../modules/expo-callkit');
      const { router } = require('expo-router');
      unsub = ExpoCallKit.onCallAnswered?.((data) => {
        try {
          const callId = data?.callId || '';
          if (!callId) return;
          // Dedup: the event can replay on cold-start (flushPendingEvents) and
          // fire alongside the warm path — ignore repeats of the same call
          // within 8s so we never stack two /call screens.
          const now = Date.now();
          if (callId === lastNavCallId && (now - lastNavAt) < 8000) return;
          lastNavCallId = callId; lastNavAt = now;
          // [iOS foreground-answer drop fix 2026-05-27] DO NOT hand off to the
          // JS /call.js on answer anymore. The native CallViewController (already
          // presented by CXAnswerCallAction) is a fully-functional call UI with
          // h264 video, and it WORKED. The handoff (router.push '/call?adoptNative=1'
          // → /call.js adopts the shared Room → calls dismissNativeCallVC) made the
          // native VC's deinit DISCONNECT the adopted Room → "atende e a tela
          // desliga" (only when answering, app open, callee iOS). Founder: "ele
          // funcionava com o nativo, o problema era o vídeo". Keep the native
          // screen as the answer UI; outgoing calls still use JS /call.js.
          // (Native build also adds a cededToJs deinit guard as belt-and-braces.)
          void callId;
        } catch {}
      }) || (() => {});
    } catch {}
    return () => { try { unsub(); } catch {} };
  }, []);

  // Pre-fetch key data after login so screens load instantly from cache
  useEffect(() => {
    if (prefetchedRef.current) return;
    // Don't prefetch until we have a confirmed login. Otherwise we fire
    // contacts_list, notes_list, drive_list, etc. with a stale/missing
    // bearer and the user sees a wall of 401s in the console (and the
    // prefetch invalidates each time, evicting good cache). Wait for
    // AuthContext to confirm the user before warming caches.
    if (!auth?.user?.email) return;
    prefetchedRef.current = true;
    // [2026-10-07 coldstart] Every service init below used to fire in the SAME
    // tick the cached user landed — i.e. while index.js was routing to /chat and
    // ChatListTab was doing its first render — so ~10 module evaluations +
    // starts competed with the first paint on the single JS thread. They now
    // run AFTER the chat list's first paint (services/bootTrace.afterFirstPaint,
    // capped at 2.5 s from JS start), staggered into separate macrotasks. Order
    // = importance: live persistence first, send paths next, housekeeping last.
    // Global chat persistence — WhatsApp-style local-first. Every WS / MQTT /
    // TCP chat event (msg, edit, delete, reaction) lands in SQLite + SmartCache
    // the instant it arrives, no matter which screen is open. Before this, only
    // the open chat-conversation screen persisted incoming msgs; a push that
    // arrived while the user was on the chat list left the msg in memory only —
    // tapping the chat then re-fetched it from the server (and showed a
    // skeleton flash). Idempotent + safe across re-login.
    afterFirstPaint(() => {
      try {
        import('../services/chatPersistence').then(m => {
          try { m.startChatPersistence?.(); } catch {}
          // Eager hydrate SQLite + SmartCache so the very first paint of any
          // chat screen already has data on disk-backed local-first cache.
          try { m.hydrateChatFromDisk?.().catch?.(() => {}); } catch {}
        });
      } catch {}
    }, 0);
    // Prime contact nicknames (per-user display-name overrides). The MMKV copy
    // is loaded synchronously at module eval; this is the network refresh.
    afterFirstPaint(() => { try { import('../services/nicknames').then(m => m.refreshNicknames?.().catch(() => {})); } catch {} }, 0);
    // Outbox drainer — retries any chat_send that was queued while offline.
    // Drains on boot, on network reconnect, on WS reconnect, and every 60s.
    // Server dedup by client_message_id makes double-sends impossible.
    afterFirstPaint(() => { try { import('../services/outboxDrainer').then(m => m.initOutboxDrainer?.()); } catch {} }, 150);

    // WhatsApp-grade send worker (#1169) — SQLite-backed outbox state machine
    // with WS-first delivery + exponential backoff + per-conversation FIFO.
    // Lives alongside the legacy drainer above; both are idempotent (server
    // dedups by client_message_id), the new worker just provides UI status
    // visibility ("Enviando...", "Tentando de novo (3)") via SendStatusText.
    afterFirstPaint(() => { try { import('../services/sendWorker').then(m => m.start?.()); } catch {} }, 150);

    // Online recovery orchestrator — WhatsApp-grade auto-sync. Listens for
    // NetInfo offline→online flips, WS authenticated reconnects, and
    // AppState 'active' transitions; coalesces them with an 800ms debounce
    // and runs: outbox flush → conv delta sync → chat list refresh →
    // envelope pull. See services/onlineRecoveryOrchestrator.js.
    afterFirstPaint(() => {
      try {
        import('../services/onlineRecoveryOrchestrator').then(m => {
          try {
            const apiMod = require('../services/api');
            m.startOnlineRecovery?.(apiMod);
          } catch {}
        });
      } catch {}
    }, 250);
    // Scan disk media cache (chat-media-cache/ + chat-media-saved/) to refresh
    // the synchronous URL→file:// index against the real disk (readDirectory
    // over thousands of files — the reason it is no longer in the boot gate).
    afterFirstPaint(() => { try { import('../services/mediaCache').then(m => m.initSyncCache?.().catch(() => {})); } catch {} }, 600);
    // Warm memory cache from persistent storage (non-chat tabs only).
    afterFirstPaint(() => { warmCache(['contacts', 'calendar_events', 'files_root', 'notes', 'one_conversations']).catch(() => {}); }, 1200);

    // [share outbox bridge, 2026-05-19] Subscribe to native iOS ShareExtension
    // completion events. Without this, shares sent via the iOS Share Sheet
    // never update the in-app chat list until the user pull-to-refreshes —
    // the extension uploads silently in its own process. The bridge fires
    // when the extension finishes a share session (Darwin notification →
    // AppDelegate NSNotification → ExpoCallKit `onShareDidSend` event) and
    // triggers a deltaSync.syncNow() so the chat list + affected
    // conversation reflect the newly-sent message.
    afterFirstPaint(() => {
      try {
        import('../services/shareOutbox').then(m => {
          try {
            m.subscribeShareOutbox?.(m.defaultShareOutboxHandler);
          } catch {}
        });
      } catch {}
    }, 400);

    // [chat cloud backup scheduler, 2026-05-20] Fire-and-forget — registers
    // the once-a-day chat backup BG task. The scheduler self-gates on the
    // 20h window + battery ≥20% + non-roaming network, and short-circuits
    // when the user hasn't cached a passphrase yet (setup not finished).
    // Safe to call on every cold start: expo-task-manager + BackgroundFetch
    // dedupe by task name, so re-registering is a no-op.
    afterFirstPaint(() => {
      try {
        import('../services/backupScheduler').then(m => {
          try { m.scheduleDaily?.().catch(() => {}); } catch {}
        });
      } catch {}
    }, 3000);

    // [photo backup worker reconcile, 2026-05-19] Android-only — when the
    // BackupWorker uploads photos in the background while the app is
    // killed, it writes a delta file (~/files/chatyy-backup-delta.json)
    // and emits a LocalBroadcast. JS reads the file on AppState 'active'
    // and listens for the live broadcast so the in-app backed_up_map
    // stays consistent and the backup screen shows correct counts. Without
    // this, the next foreground re-attempts already-uploaded files
    // (server dedups via content_hash but wastes battery on the rescan).
    afterFirstPaint(() => {
      try {
        import('../services/photoBackup').then(m => {
          try { m.wireWorkerReconcile?.(); } catch {}
        });
      } catch {}
    }, 3000);

    // Share-intent: one-shot check at startup. The CONTINUOUS live listener
    // (for shares that arrive while the app is already running in the
    // background) is wired via `useShareIntent()` hook below in RootLayout.
    if (Platform.OS !== 'web') {
      try {
        const { getShareIntent } = require('expo-share-intent');
        getShareIntent?.().then(intent => {
          if (!intent) return;
          const file = intent.files?.[0];
          const params = {};
          if (file?.path) {
            params.uri = file.path;
            params.type = (file.mimeType || '').startsWith('video') ? 'video' : 'image';
            // Sanitize: expo-share-intent occasionally surfaces the literal
            // string "$value" as fileName when iOS doesn't expose a real
            // filename for the shared item (Files-app PDFs especially).
            // Without this, the bubble shows "$value.pdf" and the URL stored
            // in R2 ends up as ".../chat/<hash>_$value.pdf". Fall back to
            // the URI's basename or a generic name.
            params.name = _sanitizeShareName(file.fileName, file.path, file.mimeType);
            params.mime = file.mimeType || '';
            params.files = _shareFilesParam(intent.files);
          }
          else if (intent.text) { params.text = intent.text; params.type = 'text'; }
          else if (intent.webUrl) { params.text = intent.webUrl; params.type = 'text'; }
          if (Object.keys(params).length) {
            setTimeout(() => _openShareReceive(router, params), 300);
          }
        }).catch(() => {});
      } catch {}
    }
    // Bootstrap: ONE request gets ALL data (Redis-cached on server = instant)
    const doPreload = async () => {
      try {
        const apiMod = await import('../services/api');
        const { cacheConversations, cacheMessages, purgeAllPendingOnceOnMigration } = await import('../services/chatCache');
        let SmartCache = null;
        try { SmartCache = require('../services/smartChatCache'); } catch {}

        // One-time migration: clear stuck pending messages from past backend bugs
        purgeAllPendingOnceOnMigration().catch(() => {});

        // Call bootstrap first (returns everything in 1 request, cached 60s on server)
        try {
          const boot = await apiMod.bootstrap();
          if (boot?.success && boot.data?.conversations) {
            cacheConversations(boot.data.conversations).catch(() => {});
            // Mirror to SmartCache so synchronous sync getters used in
            // ChatListTab/chat-conversation initializers see the data on the
            // very first render — no async wait, no skeleton flash.
            try { SmartCache?.cacheConversations?.(boot.data.conversations); } catch {}
          }
        } catch {}

        // Then prefetch remaining data in parallel
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00:00`;

        // [cold-start 2026-10-01] Chat-first boot: contacts/calendar/files/notes
        // are NOT on the chat landing screen, so prewarming them in the first
        // seconds stole network from the chat cold start (sync/media/WS). KEEP
        // the prewarm — those tabs still open instantly later — but pay for it
        // LATE and at low priority: wait for the mount interaction to settle,
        // then a further idle delay, so it rides well behind chat's first
        // paint. Same defer idiom the boot already uses for LiveKit/Sentry/
        // webPush. NOT removed, just rescheduled out of the chat window.
        const prewarmAncillary = () => {
          prefetch('contacts', () => apiMod.getContactsList(), 600000).catch(() => {});
          prefetch('calendar_events', () => apiMod.calEvents(fmt(start), fmt(end)), 600000).catch(() => {});
          prefetch('files_root', () => apiMod.fileList(null), 600000).catch(() => {});
          prefetch('notes', () => apiMod.notesList({}), 600000).catch(() => {});
        };
        try {
          InteractionManager.runAfterInteractions(() => {
            setTimeout(prewarmAncillary, 6000);
          });
        } catch {
          setTimeout(prewarmAncillary, 8000);
        }

        // WhatsApp-invisible-sync (2026-05-18): chat messages are now
        // fetched ON OPEN (lazy), not in a 7.5s bootstrap burst. We just
        // refresh the conversation list (cheap, single request) so the
        // sidebar shows fresh unread counts / last-message previews when
        // the user lands on /chat. Per-conv messages already paint from
        // SQLite/SmartCache and only hit the network when the user opens
        // a specific conversation.
        setTimeout(async () => {
          try {
            const convRes = await apiMod.chatConversations();
            if (convRes?.success) {
              const convs = convRes.data?.conversations || convRes.data?.chats || [];
              cacheConversations(convs).catch(() => {});
              try { SmartCache?.cacheConversations?.(convs); } catch {}
            }
          } catch {}
        }, 2000);

      } catch {}
    };
    // Delay pre-fetch to not compete with initial inbox load
    // [2026-10-07 coldstart] anchored to the chat list's first paint.
    afterFirstPaint(doPreload, 2500);

    // Stage D (#1200, 2026-05-20): GLOBAL trigger for the WhatsApp-grade
    // full-history bootstrap. Previously chat.js was the ONLY entry point —
    // mobile users land on /chat by default so that mostly worked, but
    // desktop users who open /inbox/status/etc as the first screen never
    // kicked off the SQLite-first bootstrap until they manually opened the
    // chat tab. Same idempotency rules: the function short-circuits on the
    // SQLite gate if it's already 'done', and on the singleton flag if a
    // run is already in flight. The 2500ms delay lets first paint settle.
    if (Platform.OS !== 'web') {
      // [2026-10-07 coldstart] anchored to the chat list's first paint.
      afterFirstPaint(() => {
        try {
          const { bootstrapFullHistoryOnce } = require('../services/fullHistorySync');
          const apiMod = require('../services/api');
          bootstrapFullHistoryOnce(apiMod.apiCall, auth.user.email).catch(() => {});
        } catch {}
      }, 2000);
      // Stage E (#1247, 2026-05-21): WhatsApp-grade BACKGROUND media auto-sync.
      // Separate from the bootstrap loop — that one walks message history; this
      // one fills any media row whose local_path stayed NULL after WS push +
      // bootstrap (cellular gate, network blip, app killed mid-download). Loop
      // wakes on AppState→active, wifi flip, WS chat_message, and a 5min idle
      // tick. The user's request: "deveria sincronizar automaticamente pra
      // nunca faltar nada" — Settings now reads from this loop's progress so
      // they see "Sincronizado" instead of "Mídias faltantes: 47".
      afterFirstPaint(() => {
        try {
          const { initMediaAutoSync } = require('../services/mediaAutoSync');
          initMediaAutoSync(auth.user.email);
        } catch {}
      }, 3500);
    }
  }, [auth?.user?.email]);

  // Track screen navigation changes
  useEffect(() => {
    if (pathname && pathname !== pathnameRef.current) {
      pathnameRef.current = pathname;
      try { trackPageview(pathname); } catch {}
    }
  }, [pathname]);

  // Register service worker on web — enables offline support + instant
  // repeat visits. The sw.js file is already deployed at /sw.js but was
  // never being registered, so every visit re-downloaded the 5MB bundle.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        // Fails silently in dev (http://localhost doesn't allow SW); prod is fine.
        if (__DEV__) console.warn('[sw] registration failed:', e?.message);
      });
      // [notif-p0p1] Register the Firebase Web SDK FCM token so backend can
      // push to web sessions. Lazy-loaded so Firebase Web SDK only hits the
      // wire when this branch fires. Deferred 2s past first paint so it
      // doesn't compete with the critical bundle.
      setTimeout(() => {
        try {
          import('../services/webPush').then((m) => {
            try { m.registerForWebPush(); } catch (e) { if (__DEV__) console.warn('[webPush]', e?.message); }
          }).catch(() => {});
        } catch {}
      }, 2000);
    }
  }, []);

  useEffect(() => {
    // Initialize global error handlers (Sentry + crash reporter) — deferred
    // ~1s past first paint via InteractionManager so cold start doesn't pay
    // Sentry's native init cost on the critical path. Errors thrown before
    // this fires fall through to the native handler, which is fine — Sentry
    // ScopedSpans / native breadcrumbs catch them once it's up.
    if (Platform.OS !== 'web') {
      InteractionManager.runAfterInteractions(() => {
        setTimeout(initGlobalErrorHandlers, 0);
      });
    } else {
      initGlobalErrorHandlers();
    }

    // Privacy/security global init — hydrates saved proxy/Tor config + screen
    // capture block setting from AsyncStorage and applies them to the native
    // HTTP / screen layers. Best-effort: missing native modules are logged
    // but never throw. Runs after first paint so cold start cost is hidden.
    if (Platform.OS !== 'web') {
      InteractionManager.runAfterInteractions(() => {
        try {
          import('../services/proxyConfig').then(m => m.initProxyConfig?.()).catch(() => {});
          import('../services/screenCaptureGate').then(m => m.initScreenCaptureGate?.()).catch(() => {});
        } catch {}
      });
    }

    // Inject CSS animations for auth background decorations
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const id = 'auth-bg-animations';
      if (!document.getElementById(id)) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
          @keyframes float1 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(30px,20px)} 66%{transform:translate(-20px,10px)} }
          @keyframes float2 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-25px,-15px)} 66%{transform:translate(15px,-25px)} }
          @keyframes float3 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,25px)} }
          @keyframes dropdownIn { from{opacity:0;transform:translateY(-8px) scale(0.96)} to{opacity:1;transform:translateY(0) scale(1)} }
          @keyframes fadeIn { from{opacity:0} to{opacity:1} }
          @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
          @keyframes starPop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
          @keyframes slideInRight { from{transform:translateX(100%)} to{transform:translateX(0)} }
          @keyframes emailRowIn { from{opacity:0;transform:translateX(-12px)} to{opacity:1;transform:translateX(0)} }
          @keyframes scaleIn { from{opacity:0;transform:scale(0.92)} to{opacity:1;transform:scale(1)} }
          @keyframes ripple { 0%{transform:scale(0);opacity:0.4} 100%{transform:scale(2.5);opacity:0} }
          @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
          @keyframes shimmerSlide { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
          .shimmer-loading { background: linear-gradient(90deg, transparent 25%, rgba(255,255,255,0.08) 50%, transparent 75%); background-size: 200% 100%; animation: shimmer 1.5s ease-in-out infinite; }
          @keyframes pulseGlow { 0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,0)} 50%{box-shadow:0 0 0 12px rgba(37,99,235,0.12)} }
          @keyframes badgeBounce { 0%{transform:scale(0.3)} 60%{transform:scale(1.15)} 100%{transform:scale(1)} }
          @keyframes smoothSlideIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
          @keyframes folderHighlight { from{background-color:transparent} to{background-color:rgba(37,99,235,0.08)} }
          @keyframes starGlow { 0%{filter:drop-shadow(0 0 0 rgba(245,158,11,0))} 50%{filter:drop-shadow(0 0 8px rgba(245,158,11,0.6))} 100%{filter:drop-shadow(0 0 0 rgba(245,158,11,0))} }
          input:-webkit-autofill { -webkit-box-shadow: 0 0 0 30px white inset !important; }
          * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
          html { scroll-behavior: smooth; }
          body { overscroll-behavior: none; }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.15); border-radius: 6px; }
          ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.3); }
          @media (min-width: 900px) {
            ::-webkit-scrollbar { width: 8px; }
          }
          /* Smooth transitions on interactive elements */
          [data-pressable], [role="button"] { transition: transform 0.15s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.15s ease, background-color 0.18s ease; }
          [data-pressable]:active, [role="button"]:active { transform: scale(0.97); }
          /* Selection color */
          ::selection { background: rgba(37,99,235,0.2); color: inherit; }
          /* Focus ring for keyboard navigation */
          :focus-visible { outline: 2px solid rgba(17, 17, 17,0.6); outline-offset: 2px; border-radius: 4px; }
          /* Smooth image loading */
          img { transition: opacity 0.3s ease; }
          /* Desktop chat message hover */
          @media (min-width: 900px) {
            @keyframes msgHover { from { background-color: transparent; } to { background-color: rgba(128,128,128,0.04); } }
          }
          /* Tooltip styles */
          [data-tooltip] { position: relative; }
          [data-tooltip]:hover::after { content: attr(data-tooltip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 4px 10px; border-radius: 6px; font-size: 11px; white-space: nowrap; background: rgba(0,0,0,0.8); color: #fff; pointer-events: none; animation: fadeIn 0.15s ease; z-index: 999; }
        `;
        document.head.appendChild(style);
      }
    }

    let mounted = true;

    // Analytics tracking — app_open for native only (web pageviews tracked by pathname useEffect)
    // [2026-10-07 coldstart] analytics beacon after first paint (+1 s).
    if (Platform.OS !== 'web') {
      afterFirstPaint(() => { try { trackAppOpen(); } catch {} }, 1000);
    }

    // Set foreground notification handler for in-app toast (works on all platforms)
    (async () => {
      try {
        const { setForegroundNotificationHandler } = await import('../services/pushNotifications');
        setForegroundNotificationHandler((notif) => {
          if (mounted) onNotification?.(notif);
        });
      } catch {}
    })();

    // Listen for login_challenge events via WebSocket (all platforms including web)
    let wsLoginUnsub = null;
    (async () => {
      try {
        const ws = (await import('../services/websocket')).default;
        const { triggerLoginChallengePrompt } = await import('../components/LoginChallengePrompt');
        wsLoginUnsub = ws.on('login_challenge', (data) => {
          if (data?.challenge_id) triggerLoginChallengePrompt(data);
        });
      } catch {}
    })();

    // [2026-05-18] Diamond gift received — surface a toast + light vibration
    // when another user sends us diamonds. The backend (wallet_send) fans the
    // event out on the recipient's user_<email> channel; the WS layer's
    // default _emit routes anything unknown by msg.type, so this works without
    // any extra protocol plumbing. Toast is best-effort — if useNotification
    // isn't mounted yet, we silently swallow.
    let wsDiamondUnsub = null;
    (async () => {
      try {
        const ws = (await import('../services/websocket')).default;
        // 2026-05-20 — cashout status flip (back-office approved/rejected
        // payouts). Quick alert toast so creators get instant feedback
        // even with the app foregrounded. Cold-app delivery is covered
        // by the FCM push the backend already fires alongside this WS.
        try {
          ws.on('cashout_status', (data) => {
            try {
              const status = String(data?.status || '');
              const amountBrl = ((Number(data?.amount_cents) || 0) / 100).toFixed(2).replace('.', ',');
              const TITLES = {
                en: { paid: 'Cashout paid', rejected: 'Cashout rejected' },
                es: { paid: 'Retiro pagado', rejected: 'Retiro rechazado' },
                pt: { paid: 'Saque pago', rejected: 'Saque recusado' },
              };
              const BODIES = {
                en: { paid: `R$ ${amountBrl} sent to your PIX.`, rejected: data?.admin_note || 'Try again with another key.' },
                es: { paid: `R$ ${amountBrl} enviados a tu PIX.`, rejected: data?.admin_note || 'Inténtalo con otra clave.' },
                pt: { paid: `R$ ${amountBrl} enviados pra sua chave PIX.`, rejected: data?.admin_note || 'Tente novamente com outra chave.' },
              };
              let lang = 'pt';
              try {
                if (typeof navigator !== 'undefined' && navigator?.language) {
                  lang = String(navigator.language).slice(0, 2);
                }
              } catch {}
              const t = TITLES[lang] || TITLES.pt;
              const b = BODIES[lang] || BODIES.pt;
              if (status === 'paid' || status === 'rejected') {
                const { Platform, Alert } = require('react-native');
                if (Platform.OS === 'web' && typeof window !== 'undefined') {
                  if (window.Notification && window.Notification.permission === 'granted') {
                    try { new window.Notification(t[status], { body: b[status] }); } catch {}
                  }
                } else {
                  Alert.alert(t[status], b[status]);
                }
              }
            } catch {}
          });
        } catch {}
        wsDiamondUnsub = ws.on('diamond_received', (data) => {
          try {
            const fromName = data?.from_name || (data?.from_email || '').split('@')[0] || 'Alguém';
            const amount = Number(data?.amount) || 0;
            const msg = data?.message ? `\n${data.message}` : '';
            // Pulse vibration on native; web silently no-ops.
            try {
              const { Vibration } = require('react-native');
              Vibration?.vibrate?.([0, 30, 60, 30]);
            } catch {}
            // Visible surface: web → native browser notification (if granted),
            // native → an Alert so the receiver immediately knows the
            // transfer arrived. Push notification covers cold-app delivery
            // already; this is the foreground/real-time path.
            try {
              const { Platform, Alert } = require('react-native');
              // 2026-05-20: i18n template via translations module; PT-BR default
              // since the _layout-level WS handler runs before LanguageProvider
              // has resolved (would need a Context.Consumer hop). Tradeoff:
              // English/Spanish users get the PT title for ~50ms cold-start
              // — better than hardcoded with no fallback.
              let title = `${fromName} te enviou ${amount} ◆`;
              try {
                let detected = 'pt';
                try {
                  if (typeof navigator !== 'undefined' && navigator?.language) {
                    detected = String(navigator.language).slice(0, 2);
                  }
                } catch {}
                const TEMPLATES = {
                  en: '{name} sent you {n} ◆',
                  es: '{name} te envió {n} ◆',
                  pt: '{name} te enviou {n} ◆',
                };
                const tpl = TEMPLATES[detected] || TEMPLATES.pt;
                title = tpl.replace('{name}', fromName).replace('{n}', amount);
              } catch {}
              if (Platform.OS === 'web' && typeof window !== 'undefined') {
                if (window.Notification && window.Notification.permission === 'granted') {
                  try { new window.Notification(title, { body: msg.trim() || undefined }); } catch {}
                }
              } else {
                Alert.alert(title, msg.trim() || undefined);
              }
            } catch {}
          } catch {}
        });
      } catch {}
    })();

    // [2026-05-16 Stage 3+4] Install the relay responder so this device
    // (whichever it is) can answer chat-history relay_request frames sent
    // by other devices on the same account. On the phone this satisfies
    // the web companion's reads; on the web this is a no-op because web
    // is never the target of relay_request (it doesn't own SQLite history).
    // Safe to install eagerly — handler is a single ws.on() registration.
    let relayResponderUnsub = null;
    // [2026-10-07 coldstart] relay answers are for OTHER devices — after paint.
    afterFirstPaint(async () => {
      try {
        if (!mounted) return;
        const { installRelayResponder } = await import('../services/relayResponder');
        if (!mounted) return;
        relayResponderUnsub = installRelayResponder();
      } catch (e) {
        // Non-fatal — relay is best-effort.
        console.warn('[relayResponder] install failed:', e?.message);
      }
    }, 500);

    if (Platform.OS === 'web') return () => {
      mounted = false;
      if (wsLoginUnsub) wsLoginUnsub();
      if (wsDiamondUnsub) wsDiamondUnsub();
      if (relayResponderUnsub) relayResponderUnsub();
    };

    (async () => {
      try {
        const {
          setupNotificationListeners,
          clearBadge,
        } = await import('../services/pushNotifications');

        if (!mounted) return;

        // Listener SETUP needs no permission — safe to wire on cold start,
        // even before login. The push PERMISSION request + token registration
        // (ensurePushTokenFresh → registerForPushNotifications) is deferred to
        // the auth-gated effect below so a brand-new user never sees the push
        // dialog before they log in. [FIX push-prompt 2026-10-05]
        // [2026-10-06 android-audit] Compose with any cleanup already stored
        // (the contacts/badge AppState subscription below is registered
        // synchronously, before this await resolves) instead of overwriting it.
        const _notifCleanup = await setupNotificationListeners();
        const _prevCleanup = cleanupRef.current;
        cleanupRef.current = () => { try { _notifCleanup?.(); } catch {} try { _prevCleanup?.(); } catch {} };

        // Clear badge when app opens
        clearBadge();
      } catch {}
    })();

    // Schedule local notifications for upcoming meetings
    // [2026-10-07 coldstart] not needed for the first screen → after paint.
    afterFirstPaint(async () => {
      try {
        if (!mounted) return;
        const { initMeetingReminders } = await import('../services/meetingReminders');
        if (mounted) await initMeetingReminders();
      } catch {}
    }, 2000);

    // Setup CallKit + VoIP Push (iOS only)
    // SKIP on web to avoid TDZ issues in callkeep module
    if (Platform.OS !== 'web') {
      (async () => {
        try {
          const { setupCallKeep } = await import('../services/callkeep');
          if (mounted) await setupCallKeep();
        } catch (e) {
          console.warn('[CallKeep] Setup failed:', e.message);
        }
      })();
    }

    // IAP init is deferred until the user actually opens the /plans screen.
    // Initializing at app startup crashed build 365 on some devices because
    // expo-iap's native connection setup raised unhandled errors before the
    // RN error boundary was mounted. Calling it lazily from plans.js
    // keeps the home screen usable for everyone else.

    // Sync phone contacts in background (so server knows which contacts we have, for new user notifications)
    //
    // WhatsApp-grade contact discovery: we run sync IMMEDIATELY on every cold start
    // (cache short-circuits in <100ms when fresh, so this is essentially free), AND
    // re-sync every 12h to pick up contacts that joined Chatyy since the last
    // upload. The 12h cadence matches WhatsApp's documented sync interval and
    // surfaces new joiners in chat-new under the "NOVO" badge.
    //
    // Re-sync also fires on AppState → 'active' transitions when >12h elapsed,
    // so users coming back to the app after a weekend get fresh joiner badges
    // without having to open chat-new.
    if (Platform.OS !== 'web') {
      const RESYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
      const LAST_SYNC_KEY = '@chatyy_contacts_last_full_sync';
      let _syncing = false;
      const maybeRunSync = async (force = false) => {
        if (_syncing) return;
        try {
          let hasPermission = false;
          if (Platform.OS === 'ios') {
            try {
              const NativeContacts = require('../modules/expo-native-contacts').default;
              hasPermission = NativeContacts.hasContactsPermission();
            } catch {
              const Contacts = await import('expo-contacts');
              const { status } = await Contacts.getPermissionAsync();
              hasPermission = status === 'granted';
            }
          } else {
            const Contacts = await import('expo-contacts');
            const { status } = await Contacts.getPermissionAsync();
            hasPermission = status === 'granted';
          }
          if (!hasPermission) return;
          // 12h gate — read AsyncStorage timestamp; skip if recent unless `force`.
          let shouldRun = !!force;
          if (!shouldRun) {
            try {
              const AsyncStorage = require('@react-native-async-storage/async-storage').default;
              const last = parseInt((await AsyncStorage.getItem(LAST_SYNC_KEY)) || '0', 10);
              shouldRun = !last || (Date.now() - last) >= RESYNC_INTERVAL_MS;
            } catch { shouldRun = true; }
          }
          if (!shouldRun) return;
          _syncing = true;
          const { syncContacts, getContactsConsentState } = await import('../services/contactSync');
          // [Play compliance 2026-06-04] O auto-sync de boot só roda se o
          // usuário JÁ deu consentimento explícito dentro do fluxo de contatos
          // (chat-new / tela Contatos). Antes, syncContacts() podia disparar o
          // diálogo de consentimento ~1.5s após abrir o app — fora de contexto,
          // o que o Google reprova (a prominent disclosure tem que aparecer no
          // uso normal do RECURSO, não num popup de cold-start).
          const _consent = await getContactsConsentState();
          if (_consent !== 'granted') { _syncing = false; return; }
          // `forceRefresh=true` bypasses the 1h in-memory cache so the server
          // sees a fresh hash batch — that's what wakes up "X entrou no Chatyy"
          // push notifications on the contact's side (chat_phone_registry hit).
          await syncContacts(true);
          try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            await AsyncStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
          } catch {}
        } catch {}
        finally { _syncing = false; }
      };
      // Initial sync — 1.5s after mount so we don't fight cold-start work.
      // [2026-10-07 coldstart] 1.5 s AFTER the chat list's first paint.
      afterFirstPaint(() => { if (mounted) maybeRunSync(false).catch(() => {}); }, 1500);
      // AppState foreground re-check — react-native AppState 'change' fires
      // every time the user comes back; we gate by the 12h timestamp so this
      // is cheap on rapid switches.
      try {
        const { AppState } = require('react-native');
        const sub = AppState.addEventListener('change', (s) => {
          if (s === 'active') {
            maybeRunSync(false).catch(() => {});
            // [2026-10-02] Reconcile the app-icon badge on warm foreground.
            // Pushes that landed while backgrounded leave the OS badge stuck
            // until the user happens to open a chat; refreshBadgeCount recomputes
            // it from server-side unread (chat + email).
            try { require('../services/pushNotifications').refreshBadgeCount?.().catch(() => {}); } catch {}
          }
        });
        // Stash on the ref so cleanup below can remove it.
        cleanupRef.current = (() => {
          const prev = cleanupRef.current;
          return () => { try { sub?.remove?.(); } catch {} if (prev) prev(); };
        })();
      } catch {}
    }

    // Initialize auto photo backup (global, not tied to Photos screen)
    // Listens for new photos (MediaLibrary) and app foreground (AppState)
    if (Platform.OS !== 'web') {
      // [2026-10-07 coldstart] 2 s after first paint (was 2 s after mount,
      // which on a slow device still landed inside the first-paint window).
      afterFirstPaint(() => {
        initAutoBackup().catch(() => {});
      }, 2000); // Start backup quickly (was 10s - too slow, user minimizes before)
    }

    // OTA disabled in app — updates via TestFlight/Play Store builds only
    // OTA was causing app to slow down and crash with too many stacked updates
    // See: https://github.com/expo/expo/issues/26231

    return () => {
      mounted = false;
      if (cleanupRef.current) cleanupRef.current();
      if (wsLoginUnsub) wsLoginUnsub();
      if (wsDiamondUnsub) wsDiamondUnsub();
      if (relayResponderUnsub) relayResponderUnsub();
    };
  }, []);

  // [FIX push-prompt 2026-10-05] Auth-gated push token registration.
  // registerForPushNotifications() is what triggers the OS push-permission
  // dialog, so we only run it once the user is authenticated — a brand-new
  // user reaching the login screen never sees the push prompt first. This
  // covers cold start with an already-hydrated session; AuthContext's
  // registerPushAfterAuth covers explicit login / account switch. Both go
  // through ensurePushTokenFresh, whose per-{token,account} send guard makes
  // the overlap a no-op. Native only — web uses the Service Worker path.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!authUser?.email) return;
    let alive = true;
    (async () => {
      try {
        const { ensurePushTokenFresh } = await import('../services/pushNotifications');
        if (!alive) return;
        await ensurePushTokenFresh({ force: true });
      } catch {}
    })();
    return () => { alive = false; };
  }, [authUser?.email]);

  return null;
}

// What's New tour gate — checks AsyncStorage on each login transition and
// pops the WhatsNewSheet once per upgrade. Mounts inside AuthProvider so
// `useAuth()` is available; renders nothing for cold-installs (gated by
// shouldShowWhatsNew which only returns true when last-seen-version differs
// from CURRENT_VERSION, never on first run).
function WhatsNewGate() {
  const auth = useAuth();
  const router = useRouter();
  const [show, setShow] = useState(false);
  const probedForRef = useRef(null);

  useEffect(() => {
    const email = auth?.user?.email;
    if (!email) {
      probedForRef.current = null;
      return;
    }
    if (auth?.loading) return;
    if (probedForRef.current === email) return;
    probedForRef.current = email;
    // Defer so first-frame render isn't blocked by AsyncStorage roundtrip.
    const timer = setTimeout(async () => {
      try {
        const ok = await shouldShowWhatsNew();
        if (ok) setShow(true);
      } catch {}
    }, 1200);
    return () => clearTimeout(timer);
  }, [auth?.user?.email, auth?.loading]);

  const handleClose = useCallback(() => setShow(false), []);
  const handleTileCta = useCallback((tile) => {
    setShow(false);
    if (tile?.ctaRoute) {
      // Brief delay so the sheet's close animation can play before nav.
      setTimeout(() => {
        try { router.push(tile.ctaRoute); } catch {}
      }, 220);
    }
  }, [router]);

  if (!show) return null;
  const WhatsNewSheet = _whatsNew().default;
  return <WhatsNewSheet visible={show} onClose={handleClose} onTileCta={handleTileCta} />;
}

// Live share-intent watcher. Fires whenever the iOS Share Extension hands
// a payload to the main app (including while the app is already running in
// the background). WhatsApp parity — without this hook, only the first-launch
// share works and subsequent shares land on the empty /share-receive screen.
// [2026-10-06 UX] Web: keep <html lang> in sync with the app locale. The
// static shell ships `lang="en"` while the UI renders pt-BR → screen readers
// pick the wrong voice, browsers offer to "translate" a page already in the
// user's language and hyphenation/quotes follow English rules. Must live
// INSIDE LanguageProvider (reads useLanguage); renders nothing.
// [2026-10-08 web-receipts-i18n] Idioma da CONTA: ao logar/trocar de conta,
// busca chat_get_settings (app_language / device_language) e aplica via
// LanguageContext. Web com navegador en-US + conta usada em pt-BR → UI pt-BR.
// Mora DENTRO do AuthProvider (useAuth) e do LanguageProvider; não renderiza.
function AccountLanguageSync() {
  const auth = useAuth();
  const { applyAccountLanguage } = useLanguage();
  const doneForRef = useRef(null);
  const email = auth?.user?.email || null;
  useEffect(() => {
    if (!email) { doneForRef.current = null; return; }
    if (auth?.loading || doneForRef.current === email || typeof applyAccountLanguage !== 'function') return;
    doneForRef.current = email;
    try {
      const { chatGetSettings } = require('../services/api');
      Promise.resolve(chatGetSettings?.()).then((r) => {
        // Só aplica se ainda é a mesma conta (troca rápida de conta).
        if (doneForRef.current === email && r && r.success && r.data) applyAccountLanguage(r.data);
      }).catch(() => {});
    } catch {}
  }, [email, auth?.loading, applyAccountLanguage]);
  return null;
}

function HtmlLangSync() {
  const { language } = useLanguage();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    try {
      const code = String(language || 'pt-BR');
      document.documentElement.setAttribute('lang', code);
      // RTL locales flip the document direction; everything else is LTR.
      const rtl = /^(ar|he|fa|ur)(-|$)/i.test(code);
      document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    } catch {}
  }, [language]);
  return null;
}

function ShareIntentWatcher() {
  const router = useRouter();
  try {
    // Hook guard: the module only exposes useShareIntent on native.
    if (Platform.OS === 'web') return null;
    const { useShareIntent } = require('expo-share-intent');
    if (!useShareIntent) return null;
    const { shareIntent, resetShareIntent } = useShareIntent({ resetOnBackground: false });
    useEffect(() => {
      // [2026-10-09 beacons] O beacon de debug disparava em TODA abertura do
      // app (shareIntent vazio, files:0 — ~100/dia) e ainda mandava o texto/
      // URL compartilhado ao servidor. Agora: nada quando não há share; num
      // share real, amostra de 20% só com contagem + mime (sem texto, URL,
      // caminho ou nome de arquivo).
      const _hasShare = !!(shareIntent && ((shareIntent.files && shareIntent.files.length) || shareIntent.text || shareIntent.webUrl));
      if (_hasShare && Math.random() < 0.2) {
        try {
          fetch('https://chatyy.com.br/api/email.php?action=crash_report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: '[SHARE_INTENT]',
              stack: JSON.stringify({
                files: shareIntent.files?.length || 0,
                mime: shareIntent.files?.[0]?.mimeType || null,
                hasText: !!shareIntent.text,
                hasUrl: !!shareIntent.webUrl,
                sample: 0.2,
              }),
              component: 'ShareIntentWatcher',
              fatal: false,
            }),
          }).catch(() => {});
        } catch {}
      }
      if (!shareIntent) return;
      const file = shareIntent.files?.[0];
      const params = {};
      if (file?.path) {
        params.uri = file.path;
        params.type = (file.mimeType || '').startsWith('video') ? 'video' : 'image';
        params.name = _sanitizeShareName(file.fileName, file.path, file.mimeType);
        params.mime = file.mimeType || '';
        params.files = _shareFilesParam(shareIntent.files);
      } else if (shareIntent.text) {
        params.text = shareIntent.text;
        params.type = 'text';
      } else if (shareIntent.webUrl) {
        params.text = shareIntent.webUrl;
        params.type = 'text';
      }
      if (Object.keys(params).length) {
        _openShareReceive(router, params);
        try { resetShareIntent?.(); } catch {}
      }
    }, [shareIntent]);
  } catch {}
  return null;
}

export default function RootLayout() {
  const [toastNotif, setToastNotif] = useState(null);
  const [otaToast, setOtaToast] = useState(null);
  // [2026-09-24 sem flash entre telas] Fundo do navegador pintado com a cor do
  // tema do SO. Sem isto o native-stack transita sobre fundo branco → "pisca"
  // (pior no modo escuro). Segue o esquema do sistema (themeMode padrão é
  // 'system'); usa useColorScheme direto pq RootLayout está acima do ThemeProvider.
  const _osScheme = _useColorScheme();
  // [2026-10-01] O fundo do container de transição deve seguir o tema do APP
  // (theme_mode em AsyncStorage: 'light'/'dark'/'system'), não só o do SO.
  // Sem isso, quem FORÇA dark com o OS no claro (ou vice-versa) via "pisca
  // branco" nas transições. Default = esquema do OS (correto p/ 'system', que
  // é o padrão) e corrige após ler o storage — isso roda atrás do splash, então
  // não há flash visível. Defensivo: qualquer erro mantém o default do OS.
  const [_navIsDark, _setNavIsDark] = useState(_osScheme === 'dark');
  useEffect(() => {
    let alive = true;
    const resolve = (m, legacy) =>
      m === 'dark' ? true : m === 'light' ? false
      : legacy === 'true' ? true : legacy === 'false' ? false
      : _osScheme === 'dark';
    (async () => {
      try {
        if (Platform.OS === 'web') {
          const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
          if (alive) _setNavIsDark(resolve(ls?.getItem('theme_mode'), ls?.getItem('theme_dark')));
        } else {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          const [m, legacy] = await Promise.all([
            AsyncStorage.getItem('theme_mode'),
            AsyncStorage.getItem('theme_dark'),
          ]);
          if (alive) _setNavIsDark(resolve(m, legacy));
        }
      } catch { if (alive) _setNavIsDark(_osScheme === 'dark'); }
    })();
    return () => { alive = false; };
  }, [_osScheme]);
  // [2026-10-08 dark-black] = DarkColors.background (true black, no navy).
  const _navBg = _navIsDark ? '#000000' : '#ffffff';
  // [2026-10-04] Reduce Motion: swap directional slides for a quick cross-fade
  // (Apple HIG: replace slide transitions with a dissolve under Reduce Motion).
  const _reduceMotion = useReducedMotion();
  const _navAnim = (anim) => (_reduceMotion ? 'fade' : anim);
  // [2026-10-07 app-feel-nav] Transições NATIVAS de verdade. Antes: default
  // 'fade' 150ms em tudo + 'slide_from_right' 120-150ms (curva JS-like, rápida
  // demais = "cara de site"). Agora:
  //  - _PUSH: 'ios_from_right' → iOS resolve p/ o push NATIVO do
  //    UINavigationController (parallax + sombra + swipe-back full-screen);
  //    Android → slide com parallax (WhatsApp/Telegram). Sem animationDuration
  //    (deixa a curva/duração do sistema). Web mantém slide_from_right.
  //  - _FULL_MODAL: iOS fullScreenModal (cobre status bar → useSafeAreaInsets
  //    correto; pageSheet devolve o inset da RAIZ = faixa vazia no topo) —
  //    p/ telas que usam insets.top/KeyboardAvoiding (compose, photo-new...).
  //  - pageSheet ('modal') SÓ p/ tela que não empurra card nem usa insets.top
  //    (iOS renderiza card empurrado de dentro de modal ATRÁS dele).
  const _PUSH = _navAnim(Platform.OS === 'web' ? 'slide_from_right' : 'ios_from_right');
  const _FULL_MODAL = Platform.OS === 'ios' ? { presentation: 'fullScreenModal' } : { presentation: 'modal', animation: _navAnim('slide_from_bottom') };
  // Telas com header NATIVO (settings/contacts/chat-new → components/nativeHeader.js):
  // headerShown já no 1º frame (senão o header "entra" depois do push e o
  // conteúdo pula). Título/cores finais vêm do setOptions da própria tela.
  const _NATIVE_HDR = Platform.OS === 'web' ? {} : {
    headerShown: true, title: '', headerBackButtonDisplayMode: 'minimal', headerShadowVisible: true,
    // [2026-10-08 dark-black] dark = DarkColors.headerBgSolid/text (neutral, no navy).
    headerStyle: { backgroundColor: _navIsDark ? '#0b0b0b' : '#ffffff' },
    headerTintColor: _navIsDark ? '#F5F5F7' : '#111b21',
  };
  // Cache-ready gate: services/mmkv.js hydrates the in-memory cache from
  // AsyncStorage asynchronously at module load. Before that finishes,
  // SmartCache.getCachedMessagesSync / getCachedConversationsSync return
  // null and chat list + conv view paint empty → user sees skeleton +
  // photos re-download. Holding the splash for the ~100-300ms it takes to
  // hydrate eliminates the entire multi-stage cold-start flicker the user
  // reported after swipe-up kill ("se eu swipe up, abro de novo, carrega
  // tudo de novo"). Web is unaffected — localStorage is sync there.
  // [2026-10-09 lighter-app] Web só segura o 1º frame se o idioma salvo não
  // está no bundle (só pt-BR/en estão) — baixa o JSON (HTTP cache) até 1.2 s.
  const [cacheReady, setCacheReady] = useState(() => Platform.OS === 'web' && !bootLanguageNeedsPreload());
  try { _bootMark('root_layout_render'); } catch {}

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (cacheReady) return;
      let off = false;
      const done = () => { if (!off) { off = true; setCacheReady(true); } };
      preloadBootLanguage(1200).then(done, done);
      const tmo = setTimeout(done, 1500);
      return () => { off = true; clearTimeout(tmo); };
    }
    let cancelled = false;
    // [2026-10-07 coldstart] The gate no longer HIDES the native splash: the
    // chat list hides it once its first rows are drawn (services/bootTrace —
    // WhatsApp-style "splash until real content"), app/index.js hides it for
    // any other destination, and armSplashFallback() guarantees it can never
    // stay up more than 1.5 s past the gate (never worse than before).
    // [2026-10-09 boot-native] Once only. The 1.5 s timeout was never cleared
    // after the hydrate won, so EVERY boot also logged `cache_ready:timeout`
    // (read in push_diag as "100% of boots fell to the fallback").
    let _opened = false;
    const _open = (why) => {
      if (cancelled || _opened) return;
      _opened = true;
      try { clearTimeout(timeout); } catch {}
      _bootMark('cache_ready:' + why);
      setCacheReady(true);
      armSplashFallback(1500);
    };
    (async () => {
      try {
        const { waitForCacheReady } = require('../services/mmkv');
        // [2026-10-09 lighter-app] Em paralelo: idioma salvo (+ pacote do
        // disco se não for pt-BR/en). Teto 900 ms; nunca lança.
        await Promise.all([
          waitForCacheReady?.(),
          preloadBootLanguage(900).catch(() => null),
        ]);
        // [2026-10-07 coldstart] REMOVED `await mediaCache.waitForSyncIndexReady()`
        // from the gate: it ran getInfo+readDirectory over chat-media-cache AND
        // chat-media-saved (thousands of files on heavy users = 50-400 ms on a
        // mid Android) before ANY UI could render, and the chat list doesn't
        // use the media index at all. The MMKV half of the index is already
        // loaded at mediaCache module eval / after mmkv ready (with stale-
        // sandbox paths dropped, see _loadIndexFromMmkv), and the disk scan
        // still runs post-paint via AppInit → initSyncCache().
      } catch {}
      _open('mmkv');
    })();
    // Hard fallback: never hold the gate longer than 1500ms even if cache
    // hydration somehow stalls. The chat list will still cold-fetch from
    // API in that case — same as before this fix.
    const timeout = setTimeout(() => _open('timeout'), 1500);
    try { reportBootMarksSampled(); } catch {}
    return () => { cancelled = true; clearTimeout(timeout); };
  }, []);

  const handleNotification = useCallback((notif) => {
    setToastNotif(notif);
  }, []);

  if (!cacheReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ChatyyKeyboardProvider>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <ThemeProvider>
          <LanguageProvider>
          <CurrencyProvider>
          <BiometricProvider>
            <AuthProvider>
              <CallProvider>
              <MailProvider>
                <PhotosProvider>
                <ConfirmProvider>
                <AppInit onNotification={handleNotification} setOtaToast={setOtaToast} />
                <ShareIntentWatcher />
                <HtmlLangSync />
                <AccountLanguageSync />
                <OfflineNotice />
                {otaToast ? (() => {
                  const _Pressable = require('react-native').Pressable;
                  const _tappable = typeof otaToast.onPress === 'function';
                  const _bg = otaToast.kind === 'success' ? '#16a34a'
                            : otaToast.kind === 'update' ? '#111111'
                            : otaToast.kind === 'info' ? '#111111'
                            : 'rgba(30,30,30,0.95)';
                  const _wrap = {
                    position: 'absolute',
                    top: Platform.OS === 'ios' ? 54 : androidTopInset(24),
                    left: 16, right: 16,
                    backgroundColor: _bg,
                    borderRadius: 12, paddingVertical: 11, paddingHorizontal: 16,
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    zIndex: 9999,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: 0.28, shadowRadius: 16, elevation: 12,
                  };
                  const _inner = (
                    <>
                      <RNText style={{ color: '#fff', fontSize: 14, fontWeight: '600', flex: 1, textAlign: _tappable ? 'left' : 'center' }}>
                        {otaToast.text}
                      </RNText>
                      {_tappable ? (
                        <RNView style={{ backgroundColor: 'rgba(255,255,255,0.20)', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 13 }}>
                          <RNText style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Atualizar</RNText>
                        </RNView>
                      ) : null}
                    </>
                  );
                  return _tappable
                    ? <_Pressable onPress={otaToast.onPress} style={({ pressed }) => [_wrap, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel="Atualizar para a nova versão">{_inner}</_Pressable>
                    : <RNView style={_wrap}>{_inner}</RNView>;
                })() : null}
                <ThemedStatusBar />
                {/* Stage 6 — yellow "phone offline" banner shows when WS relay
                    couldn't reach the phone and we served cached data from
                    IndexedDB. Web-only; renders null on native. Above the
                    Stack so it sits at the top of every web route. */}
                <PhoneOfflineBanner />
                {/* 2026-05-18 — native-only; shows when push-token
                    registration has failed 2+ times so the user can
                    tap to retry before incoming calls silently drop. */}
                <PushTokenStaleBanner />
                <ChildRestrictionGuard>
                <Stack screenOptions={{
                  headerShown: false,
                  animation: _PUSH,
                  // [2026-09-24] Pinta o fundo do container de cada tela com a cor
                  // do tema → elimina o flash branco durante a transição.
                  contentStyle: { backgroundColor: _navBg },
                  ...(Platform.OS !== 'web' ? {
                    customAnimationOnGesture: true,
                    fullScreenGestureEnabled: true,
                  } : {}),
                }}>
                  <Stack.Screen name="index" options={{ animation: 'none' }} />
                  <Stack.Screen name="login" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="signup-phone" options={{ headerShown: false, animation: _PUSH }} />
                  <Stack.Screen name="signup-username" options={{ headerShown: false, animation: _PUSH }} />
                  <Stack.Screen name="change-phone" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="linked-phones" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="verify-phone-required" options={{ animation: 'fade', animationDuration: 150, gestureEnabled: false }} />
                  <Stack.Screen name="inbox" options={{ animation: 'fade', animationDuration: 100 }} />
                  <Stack.Screen name="compose" options={{ ..._FULL_MODAL }} />
                  <Stack.Screen name="read" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="profile" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="settings" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR }} />
                  <Stack.Screen name="bia-settings" options={{ headerShown: false, animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="meet/[id]" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="feed/[id]" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="search" options={{ headerShown: false, animation: _PUSH }} />
                  <Stack.Screen name="call" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120, gestureEnabled: false, freezeOnBlur: false }} />
                  <Stack.Screen name="call/[id]" options={{ headerShown: false, presentation: 'card', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="voicemail-recorder" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120, gestureEnabled: false }} />
                  <Stack.Screen name="meetings" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="meeting-create" options={{ ..._FULL_MODAL }} />
                  <Stack.Screen name="meeting-detail" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="meeting-recap" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="call-recap" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="files" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="calendar" options={{ presentation: 'card', animation: _PUSH, gestureEnabled: false, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="event-detail" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="chat" options={{ presentation: 'card', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="chat-conversation" options={{
                    presentation: 'card',
                    animation: _PUSH,
                    gestureEnabled: true,
                    ...(Platform.OS !== 'web' ? { fullScreenGestureEnabled: true } : {}),
                  }} />
                  <Stack.Screen name="chat-new" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR }} />
                  <Stack.Screen name="locked-chats" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 more-native] */ }} />
                  <Stack.Screen name="saved-messages" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="call-schedule" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="close-friends" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 more-native] */ }} />
                  <Stack.Screen name="status-except" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 more-native] */ }} />
                  <Stack.Screen name="profile-insights" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="profile-creator-dashboard" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="starred-messages" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 more-native] */ }} />
                  <Stack.Screen name="linked-devices" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="companion-qr" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  {/* iOS QA 2026-05-28: iOS drops 'card' pushes from inside a modal (render
                      BEHIND it). [2026-10-07 app-feel-nav] /settings agora é push (card), então
                      estes e TODO o resto aberto de /settings (notification-preferences,
                      family, pgp-keys, ...) empilham normal com swipe-back nativo. */}
                  <Stack.Screen name="activity-log" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="advanced-key" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="advanced-privacy" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="passkeys" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 passkeys] */ }} />
                  <Stack.Screen name="profile-qr" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="email-signatures" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="email-outbox" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="import-whatsapp" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-10 wa-import] */ }} />
                  <Stack.Screen name="email-import" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="pgp-keys" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="tasks" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR }} />{/* [2026-10-08 settings-redesign] header nativo (título grande) */}
                  <Stack.Screen name="notification-preferences" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="spotlight" options={{ presentation: 'card', animation: _navAnim('slide_from_bottom') }} />
                  <Stack.Screen name="bots" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="documentos" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="legal" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />{/* [2026-10-07 native-ui-build] /legal?doc=terms|privacy — push nativo (antes caía no default) */}
                  <Stack.Screen name="one" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="drive" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="photos" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="photo-new" options={{ ..._FULL_MODAL }} />
                  <Stack.Screen name="live-broadcast" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="live-viewer" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="lives-saved" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="live-replay" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="live-discover" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="notes" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="notebook-editor" options={{ presentation: 'card', animation: _PUSH, gestureEnabled: false }} />
                  <Stack.Screen name="plans" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="wallet" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="diamond-shop" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="storage" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="wallet-cashout" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="creator-earnings" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="backup" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="chat-backup" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="u/[username]" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="contacts" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR }} />
                  <Stack.Screen name="notifications" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-08 apps-native] */ }} />
                  <Stack.Screen name="notifications-feed" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="group-call" options={{ presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120, headerShown: false }} />
                  <Stack.Screen name="one-memory" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="share-receive" options={{ ..._FULL_MODAL }} />
                  <Stack.Screen name="parental" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="parental-monitor" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="parental-child-chat" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="family" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="kids-learn" options={{ presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="hashtag" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="hashtag/[tag]" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  {/* Channel follow deep-link: /ch/<handle> → chat_channel_join */}
                  <Stack.Screen name="ch/[handle]" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  {/* Snap-Map / Friends-on-a-Map (Find My Friends style). */}
                  <Stack.Screen name="snap-map" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  {/* Reels P0 — "Use this sound" deep link + Duet/Stitch composer. */}
                  <Stack.Screen name="reels-sound" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 150 }} />
                  {/* Reels recorder — dedicated full-screen camera (TikTok/Instagram-style). */}
                  <Stack.Screen name="reels-recorder" options={{ headerShown: false, presentation: 'fullScreenModal', animation: _navAnim('slide_from_bottom') }} />
                  {/* Reels drafts — grid of persisted drafts; tap to resume. */}
                  <Stack.Screen name="reels-drafts" options={{ headerShown: false, ..._FULL_MODAL }} />
                  {/* [2026-10-08 reels-publish] Reels composer — galeria/câmera → corte/capa/legenda → Publicar (2º plano). */}
                  <Stack.Screen name="reels-compose" options={{ headerShown: false, presentation: 'fullScreenModal', animation: _navAnim('slide_from_bottom'), gestureEnabled: false }} />
                  <Stack.Screen name="post-create" options={{ headerShown: false, presentation: 'fullScreenModal', animation: _navAnim('slide_from_bottom') }} />
                  <Stack.Screen name="community/[id]" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="community/create" options={{ headerShown: false, presentation: 'card', animation: _PUSH }} />
                  <Stack.Screen name="community/discover" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="forgot" options={{ animation: _PUSH }} />
                  <Stack.Screen name="marketplace" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="business" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="stickers/store" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="stickers/my" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="stickers/pack" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-10 stickers-import] */ }} />
                  <Stack.Screen name="stickers/import" options={{ headerShown: false, presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-10 stickers-import] */ }} />
                  <Stack.Screen name="share-diagnose" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="live-diagnose" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  <Stack.Screen name="call-diagnose" options={{ presentation: 'card', animation: _PUSH, ..._NATIVE_HDR /* [2026-10-09 native-headers] */ }} />
                  {/* [2026-10-09 native-sheets] Sheet do SISTEMA (detents/grabber/arrastar) p/ <NativeSheet> — components/NativeSheet.js. Web nunca empurra esta rota. */}
                  <Stack.Screen name="native-sheet" options={Platform.OS === 'web' ? { headerShown: false } : nativeSheetScreenOptions} />
                </Stack>
                </ChildRestrictionGuard>
                <Suspense fallback={null}>
                  <ActiveCallBar />
                </Suspense>
                <CallStatusBar />
                <VoiceMiniPlayer />
                <EmailUndoBar />
                <Suspense fallback={null}>
                  <IncomingCallListener />
                </Suspense>
                <Suspense fallback={null}>
                  <LiveLocationPingListener />
                </Suspense>
                <Suspense fallback={null}>
                  <LiveLocationHeartbeat />
                </Suspense>
                {/* [2026-06-28] Firebase Phone Auth REMOVIDO do login (OTP vai por
                    MSG91/Infobip no backend). Host do WebView não é mais montado —
                    zero traço de Firebase no fluxo de login. google-services.* ficam
                    (são do FCM/push, não do login). */}
                <Suspense fallback={null}>
                  <DeclineWithMessageSheet />
                </Suspense>
                <Suspense fallback={null}>
                  <LoginChallengePrompt />
                </Suspense>
                <Suspense fallback={null}>
                  <LocationRequestModal />
                </Suspense>
                <Suspense fallback={null}>
                  <PushLoginRequestModal />
                </Suspense>
                <WhatsNewGate />
                {/* [2026-10-07 native-polish] push pre-permission sheet (gap P0-6) */}
                <PushPermissionPrimer />
                <Suspense fallback={null}>
                  <PWAPromptsThemed />
                </Suspense>
                <NotificationToast
                  notification={toastNotif}
                  onDismiss={() => setToastNotif(null)}
                />
                </ConfirmProvider>
              </PhotosProvider>
              </MailProvider>
              </CallProvider>
            </AuthProvider>
          </BiometricProvider>
          </CurrencyProvider>
          </LanguageProvider>
        </ThemeProvider>
      </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
    </ChatyyKeyboardProvider>
    </GestureHandlerRootView>
  );
}
