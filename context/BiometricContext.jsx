import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { AppState, Platform, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { usePathname } from 'expo-router';
import { useLanguage } from './LanguageContext';

// Routes where biometric auto-lock must be SUPPRESSED. These are the
// pre-authentication / public screens — locking them is incoherent (the
// user has no session yet) and traps users on signup when they go to
// the gallery to pick an avatar (app backgrounds → return → lock fires
// → Face ID prompt with no bio_token registered → user can't proceed).
const AUTH_ROUTES = ['/login', '/signup', '/signup-phone', '/forgot'];

const BiometricContext = createContext({});

// ── Module-level lock bridge ────────────────────────────────────────────────
// AuthContext needs to force a re-challenge on identity changes
// (switchAccount / explicit logout) WITHOUT importing this React context
// (BiometricProvider wraps AuthProvider, and pulling the hook into AuthContext
// would create a brittle render-order coupling). The provider registers its
// `setIsLocked(true)` here on mount; AuthContext calls `lockNow()` after an
// account switch / logout so the new identity must pass biometrics before the
// app is usable again. No-op on web and when no provider is mounted.
let _lockNowFn = null;
export function lockNow() {
  try { if (typeof _lockNowFn === 'function') _lockNowFn(); } catch {}
}

// bio_token / bio_email are bound per-account so a device-wide pair can't let
// identity A's bearer unlock into identity B. The login / switch paths still
// write the legacy global keys for backward compat; these helpers add the
// per-account twin (`bio_token:<email>`).
export function bioTokenKeyFor(email) {
  const e = (email || '').toString().trim().toLowerCase();
  return e ? `bio_token:${e}` : null;
}
export function bioEmailKey() { return 'bio_email'; }

// Is there a LIVE logged-in session right now? A non-empty bearer token in
// services/api means the user is authenticated. Lazy require keeps
// BiometricProvider free of a top-level dep on api.js (and the circular-import
// risk that would create, since AuthContext also pulls this module). Used to
// decide whether the auth-route lock suppression is safe: it is ONLY safe when
// there is no session (pre-auth signup/forgot). If a session exists and the
// app returns from background onto /login (e.g. a deep-link), we MUST still
// lock — otherwise navigating away from /login exposes the unlocked session.
function _hasActiveSession() {
  try {
    const apiMod = require('../services/api');
    const tok = (typeof apiMod.getAuthToken === 'function' ? apiMod.getAuthToken() : '') || '';
    return !!String(tok).trim();
  } catch {
    return false;
  }
}

// Default lock delay when the user hasn't picked one yet. 5 s matches the
// historical behavior and avoids surprising existing users post-upgrade.
const DEFAULT_LOCK_DELAY_SEC = 5;
const BIOMETRIC_PREF_KEY = 'biometric_enabled';
// Persisted user pref for auto-lock interval. Stored as seconds so 0 is
// "immediate" and a very large value (or the literal `never`) disables
// the timer entirely. We accept the literal string `never` so we don't
// have to store sentinels like -1.
const AUTO_LOCK_INTERVAL_KEY = 'biometric_auto_lock_interval_sec';
// Picker options surfaced in Settings → Privacidade → Bloqueio automático.
// Kept here so the Settings screen can import the same source of truth.
export const AUTO_LOCK_INTERVAL_OPTIONS = [
  { value: 0,    labelKey: 'biometric.lockImmediate' },
  { value: 60,   labelKey: 'biometric.lock1Min' },
  { value: 300,  labelKey: 'biometric.lock5Min' },
  { value: 900,  labelKey: 'biometric.lock15Min' },
  { value: 'never', labelKey: 'biometric.lockNever' },
];

// Storage helper (works on both web and native)
async function getStoredPref(key) {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync(key);
  } catch { return null; }
}

async function setStoredPref(key, value) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (value != null) localStorage.setItem(key, String(value));
        else localStorage.removeItem(key);
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (value != null) await SecureStore.setItemAsync(key, String(value));
    else await SecureStore.deleteItemAsync(key);
  } catch {}
}

export function BiometricProvider({ children }) {
  const { t } = useLanguage();
  const pathname = usePathname();
  // Whether the *current* screen is one of the public auth routes.
  // Captured in a ref so the AppState handler reads the latest value
  // without re-subscribing on every navigation (which would miss
  // background events that fire mid-transition).
  const isAuthRouteRef = useRef(false);
  useEffect(() => {
    const path = String(pathname || '');
    isAuthRouteRef.current = AUTH_ROUTES.some(r => path === r || path.startsWith(r + '/') || path.startsWith(r + '?'));
  }, [pathname]);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  // Interval expressed in seconds OR the string 'never'. Default kept in
  // a ref so the AppState handler picks up changes without re-subscribing.
  const [autoLockInterval, setAutoLockIntervalState] = useState(DEFAULT_LOCK_DELAY_SEC);
  const autoLockIntervalRef = useRef(DEFAULT_LOCK_DELAY_SEC);
  useEffect(() => { autoLockIntervalRef.current = autoLockInterval; }, [autoLockInterval]);
  const backgroundTimeRef = useRef(null);
  const appStateRef = useRef(AppState.currentState);

  // Check hardware availability on mount
  useEffect(() => {
    if (Platform.OS === 'web') return; // Biometrics only on native
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
        setBiometricAvailable(hasHw && isEnrolled);

        // Load saved preference
        const stored = await getStoredPref(BIOMETRIC_PREF_KEY);
        if (stored === 'true' && hasHw && isEnrolled) {
          setBiometricEnabled(true);
        }
        // Load saved auto-lock interval pref. Accept both numeric strings
        // and the literal 'never'.
        try {
          const ival = await getStoredPref(AUTO_LOCK_INTERVAL_KEY);
          if (ival === 'never') {
            setAutoLockIntervalState('never');
          } else if (ival != null && /^\d+$/.test(String(ival))) {
            const n = parseInt(ival, 10);
            if (Number.isFinite(n) && n >= 0) setAutoLockIntervalState(n);
          }
        } catch {}
      } catch {
        setBiometricAvailable(false);
      }
    })();
  }, []);

  // Force-lock now. Called on identity changes (account switch / logout) via
  // the module-level `lockNow()` bridge so an account swap can never leave the
  // previous identity's session unlocked under the new account's eyes. Only
  // arms the overlay when biometrics are actually enabled — otherwise there's
  // nothing to unlock with and we'd trap the user behind a dead lock screen.
  const lockNowLocal = useCallback(() => {
    if (Platform.OS === 'web') return;
    if (!biometricEnabled) return;
    // Don't lock the public auth screens — but ONLY when there's genuinely no
    // session (signup/forgot pre-auth). If a live bearer exists while we're on
    // /login (e.g. an account switch that navigated through /login, or a
    // deep-link to /login while still authenticated), arming the lock is the
    // correct, secure behavior. Suppressing it there would let the previous
    // identity's unlocked overlay carry over.
    if (isAuthRouteRef.current && !_hasActiveSession()) return;
    setIsLocked(true);
  }, [biometricEnabled]);

  // Register / unregister the module-level lock bridge so AuthContext can
  // trigger a re-challenge without importing this context.
  useEffect(() => {
    _lockNowFn = lockNowLocal;
    return () => { if (_lockNowFn === lockNowLocal) _lockNowFn = null; };
  }, [lockNowLocal]);

  // Setter exposed via context. Persists the choice + updates the ref so
  // the in-flight AppState handler picks the new threshold next backgrounding.
  const setAutoLockInterval = useCallback(async (value) => {
    let coerced;
    if (value === 'never') coerced = 'never';
    else {
      const n = Number(value);
      coerced = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LOCK_DELAY_SEC;
    }
    setAutoLockIntervalState(coerced);
    autoLockIntervalRef.current = coerced;
    try { await setStoredPref(AUTO_LOCK_INTERVAL_KEY, String(coerced)); } catch {}
  }, []);

  // Monitor app state changes for auto-lock
  useEffect(() => {
    if (Platform.OS === 'web' || !biometricEnabled) return;

    const handleAppStateChange = (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'background' || nextState === 'inactive') {
        // Record when app went to background
        backgroundTimeRef.current = Date.now();
      } else if (nextState === 'active' && (prev === 'background' || prev === 'inactive')) {
        // App came back to foreground — check if we should lock.
        // Suppress lock entirely when the user is on a public auth
        // route (login / signup / forgot). They have no session, no
        // bio_token, and triggering Face ID would trap them — the
        // common case being signup picking an avatar from the gallery
        // and returning to the app a few seconds later.
        const bgTime = backgroundTimeRef.current;
        // Resolve the active threshold from the ref so a recent settings
        // change applies on the next backgrounding without waiting for a
        // listener re-subscribe.
        const ival = autoLockIntervalRef.current;
        if (ival === 'never') {
          // User opted out — never auto-lock on background return.
        } else {
          const thresholdMs = Math.max(0, Number(ival) * 1000);
          // Auth-route suppression is only safe when there is NO live session.
          // The suppression exists so signup/forgot (no bearer, no bio_token)
          // don't trap the user behind a dead lock when they return from the
          // gallery. But if a logged-in session exists and the app returns
          // from background onto /login — e.g. a deep-link to /login while
          // already authenticated — we MUST still lock: otherwise navigating
          // away from /login would expose the unlocked session. So only honor
          // the auth-route skip when no bearer is present.
          const suppressForAuthRoute = isAuthRouteRef.current && !_hasActiveSession();
          if (bgTime && (Date.now() - bgTime) >= thresholdMs && !suppressForAuthRoute) {
            setIsLocked(true);
          }
        }
        backgroundTimeRef.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription?.remove();
  }, [biometricEnabled]);

  // Authenticate with biometrics
  const authenticate = useCallback(async () => {
    if (Platform.OS === 'web') return true;
    if (authenticating) return false;
    setAuthenticating(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('biometric.unlock'),
        cancelLabel: t('common.cancel'),
        // SECURITY: the APP-LOCK must not be poppable with the device
        // passcode — otherwise anyone who knows the phone PIN bypasses the
        // app's own biometric gate. Force true biometric (Face ID / Touch ID)
        // for the unlock. The destructive-action gate (biometricGate.js) keeps
        // device fallback for usability; the app-lock does not.
        disableDeviceFallback: true,
        fallbackLabel: t('biometric.usePassword'),
      });
      if (result.success) {
        setIsLocked(false);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setAuthenticating(false);
    }
  }, [authenticating]);

  // Toggle biometric lock on/off
  const toggleBiometric = useCallback(async () => {
    if (!biometricAvailable) return false;

    if (!biometricEnabled) {
      // Turning ON: verify biometrics first
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: t('biometric.confirmEnable'),
          cancelLabel: t('common.cancel'),
          // Match the app-lock unlock: arming the lock with a real biometric
          // (not the device PIN) guarantees the same factor will be required
          // to unlock — no point enabling a lock the device passcode bypasses.
          disableDeviceFallback: true,
        });
        if (result.success) {
          setBiometricEnabled(true);
          await setStoredPref(BIOMETRIC_PREF_KEY, 'true');
          return true;
        }
        return false;
      } catch {
        return false;
      }
    } else {
      // Turning OFF
      setBiometricEnabled(false);
      setIsLocked(false);
      await setStoredPref(BIOMETRIC_PREF_KEY, null);
      return true;
    }
  }, [biometricAvailable, biometricEnabled]);

  // Auto-authenticate when locked
  useEffect(() => {
    if (isLocked && biometricEnabled && !authenticating) {
      // Small delay to let the UI render the lock screen first
      const timer = setTimeout(() => {
        authenticate();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isLocked, biometricEnabled, authenticating, authenticate]);

  // Render lock screen overlay when locked
  const lockOverlay = isLocked && biometricEnabled ? (
    <View style={ls.overlay}>
      <View style={ls.card}>
        <Text style={ls.lockIcon}>{'\uD83D\uDD12'}</Text>
        <Text style={ls.title}>Chatyy</Text>
        <Text style={ls.subtitle}>{t('biometric.unlockToContinue')}</Text>
        {authenticating ? (
          <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 24 }} />
        ) : (
          <TouchableOpacity
            style={ls.btn}
            onPress={authenticate}
            activeOpacity={0.7}
          >
            <Text style={ls.btnText}>{t('biometric.unlock')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  ) : null;

  return (
    <BiometricContext.Provider value={{
      isLocked,
      biometricEnabled,
      biometricAvailable,
      toggleBiometric,
      authenticate,
      lockNow: lockNowLocal,
      autoLockInterval,
      setAutoLockInterval,
    }}>
      {children}
      {lockOverlay}
    </BiometricContext.Provider>
  );
}

export const useBiometric = () => useContext(BiometricContext);

const ls = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
  },
  card: {
    backgroundColor: '#1a1a2e',
    borderRadius: 24,
    padding: 40,
    alignItems: 'center',
    width: 300,
  },
  lockIcon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#fff', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#9ca3af', textAlign: 'center', marginBottom: 0 },
  btn: {
    marginTop: 24,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
