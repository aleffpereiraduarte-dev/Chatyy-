import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { AppState, Platform, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useLanguage } from './LanguageContext';

const BiometricContext = createContext({});

const LOCK_DELAY_MS = 5000; // Lock after 5 seconds in background
const BIOMETRIC_PREF_KEY = 'biometric_enabled';

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
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
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
      } catch {
        setBiometricAvailable(false);
      }
    })();
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
        // App came back to foreground — check if we should lock
        const bgTime = backgroundTimeRef.current;
        if (bgTime && (Date.now() - bgTime) >= LOCK_DELAY_MS) {
          setIsLocked(true);
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
        disableDeviceFallback: false,
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
          disableDeviceFallback: false,
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
