import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import * as api from '../services/api';
import { clearAll as clearAllCache, setCacheUser } from '../services/cache';

// Lazy-load to break circular dependency: AuthContext → chatCache → db
const getLazyClearChatCache = async () => {
  const { clearChatCache } = await import('../services/chatCache');
  return clearChatCache;
};

const AuthContext = createContext(null);

// Module-level interval ref so it persists across re-renders
let _locationInterval = null;

// Child account restrictions (loaded after login)
let _childRestrictions = null;
export function getChildRestrictions() { return _childRestrictions; }
export function isChildAccount() { return _childRestrictions !== null; }

function getSavedCredentials() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const c = localStorage.getItem('mail_creds');
      return c ? JSON.parse(c) : null;
    }
  } catch {}
  return null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [switching, setSwitching] = useState(false);

  // Load stored accounts on mount
  const loadAccounts = useCallback(() => {
    setAccounts(api.getStoredAccounts());
  }, []);

  useEffect(() => {
    (async () => {
      // Helper: hydrate user from offline cache so the app stays usable
      // when there's no network. Without this, an offline launch lands on
      // /login because savedCredentials is in-memory only and is null on
      // a cold start (we intentionally never persist plaintext passwords).
      const hydrateOffline = async () => {
        if (Platform.OS === 'web') return false;
        try {
          const cachedUser = await AsyncStorage.getItem('chatyy_offline_user');
          if (cachedUser) {
            const userData = JSON.parse(cachedUser);
            if (userData?.email) {
              setCacheUser(userData.email);
              setUser(userData);
              loadAccounts();
              setLoading(false);
              return true;
            }
          }
        } catch {}
        // Last resort: any stored account at all
        try {
          const accts = api.getStoredAccounts?.() || [];
          const active = api.getActiveAccountEmail?.() || '';
          const a = accts.find(x => x.email === active) || accts[0];
          if (a?.email) {
            setUser({ email: a.email, name: a.name || a.email.split('@')[0] });
            loadAccounts();
            setLoading(false);
            return true;
          }
        } catch {}
        return false;
      };

      try {
        // Offline fast-path: if NetInfo already knows we're offline (typical
        // when user opens the app on a plane or in the subway), skip the
        // 15s checkAuth timeout entirely and hydrate from cache. Without
        // this the user sat on a blank splash until the fetch aborted.
        try {
          if (Platform.OS !== 'web') {
            const NetInfo = require('@react-native-community/netinfo').default;
            const netState = await Promise.race([
              NetInfo.fetch(),
              new Promise(r => setTimeout(() => r({ isConnected: null }), 300)),
            ]);
            if (netState && netState.isConnected === false) {
              if (await hydrateOffline()) return;
            }
          } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            if (await hydrateOffline()) return;
          }
        } catch {}

        // First try: check if server session is still alive
        const r = await api.checkAuth();
        if (r.success && r.data?.email) {
          setCacheUser(r.data.email);
          setUser(r.data);
          // Cache user data for offline access (WhatsApp-style)
          if (Platform.OS !== 'web') {
            AsyncStorage.setItem('chatyy_offline_user', JSON.stringify(r.data)).catch(() => {});
          }
          loadAccounts();
          prefetchAvatar(r.data.email);
          prefetchProfile(r.data.email);
          // Set child status immediately from server response
          if (r.data.is_child) {
            _childRestrictions = r.data.child_restrictions || {};
          } else {
            _childRestrictions = null;
          }
          // Also load full restrictions (with location tracking)
          setTimeout(() => { _loadChildStatus().catch(() => {}); }, 3000);
          setLoading(false);
          return;
        }

        // Network failure: _rawApiCall swallows fetch errors and returns
        // { success: false, message: 'Connection error' } with status 0,
        // so the catch block below never fires. Detect that here and
        // fall back to the offline-cached user.
        const looksOffline = !r?.success && (
          r?.message === 'Connection error' ||
          r?.message === 'Tempo limite excedido' ||
          r?.message === 'Servidor indisponivel'
        );
        if (looksOffline) {
          if (await hydrateOffline()) return;
        }

        // Session expired — try re-login with saved credentials
        const creds = getSavedCredentials();
        if (creds?.email && creds?.password) {
          const lr = await api.login(creds.email, creds.password);
          if (lr.success) {
            setCacheUser(lr.data?.email || creds.email);
            setUser(lr.data);
            loadAccounts();
            setLoading(false);
            return;
          }
          // If login returned "Incorrect email or password", truly logged out
          // But if it was a network/server error, keep user logged in with cached data
          if (lr.message && lr.message.includes('Incorrect')) {
            // Real auth failure - do nothing, will show login screen
          } else {
            // Server error (503, timeout) - use cached user data
            setUser({ email: creds.email, name: creds.email.split('@')[0] });
            loadAccounts();
            setLoading(false);
            return;
          }
        }

        // Final fallback: try offline cache before kicking to login.
        // This rescues users who don't have an in-memory password (most
        // returning users after an app restart).
        if (await hydrateOffline()) return;
      } catch (e) {
        // Network error - try to use cached credentials (web) or AsyncStorage (native)
        const creds = getSavedCredentials();
        if (creds?.email) {
          setUser({ email: creds.email, name: creds.email.split('@')[0] });
          loadAccounts();
          setLoading(false);
          return;
        }
        if (await hydrateOffline()) return;
      }
      loadAccounts();
      setLoading(false);
    })();
  }, []);

  // Check if this is a child account and apply restrictions
  async function _loadChildStatus() {
    try {
      const r = await api.parentalMyStatus();
      if (r?.success && r.data?.is_child) {
        _childRestrictions = r.data.restrictions || {};
        console.log('[parental] Child account detected, restrictions:', Object.keys(_childRestrictions));
        // Start location tracking after a delay (avoid crash on init)
        setTimeout(() => {
          try { _startChildLocationTracking(); } catch (e) {
            console.warn('[parental] Location tracking failed:', e?.message);
          }
        }, 5000);
      } else {
        _childRestrictions = null;
      }
    } catch (e) {
      console.warn('[parental] Status check failed:', e?.message);
      _childRestrictions = null;
    }
  }

  // Send location to parent every 2 minutes
  function _startChildLocationTracking() {
    if (_locationInterval) clearInterval(_locationInterval);
    const sendLocation = async () => {
      try {
        if (Platform.OS === 'web') return;
        const { getCurrentPositionAsync, requestForegroundPermissionsAsync } = require('expo-location');
        const { status } = await requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await getCurrentPositionAsync({ accuracy: 4 }); // balanced
        const battery = -1; // TODO: get battery level
        await api.parentalUpdateLocation(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy, battery);
      } catch {}
    };
    sendLocation(); // send immediately
    _locationInterval = setInterval(sendLocation, 120000); // every 2 min
  }

  const registerPushAfterAuth = useCallback(async () => {
    try {
      if (Platform.OS === 'web') return;
      const { registerForPushNotifications, sendTokenToBackend } = await import('../services/pushNotifications');
      const token = await registerForPushNotifications();
      if (token) sendTokenToBackend(token);
    } catch {}
  }, []);

  // Pre-fetch profile data on login so profile screen loads instantly
  // Also updates user.name with the profile display name
  const prefetchProfile = useCallback((email) => {
    if (!email) return;
    api.getProfile().then(r => {
      if (r.success && r.data) {
        import('../services/cache').then(({ setCache }) => {
          setCache('user_profile', r.data, 600000);
        }).catch(() => {});
        // Update user name from profile if available
        const profileName = r.data.display_name || r.data.name;
        if (profileName) {
          setUser(prev => prev ? { ...prev, name: profileName } : prev);
        }
      }
    }).catch(() => {});
  }, []);

  // Pre-fetch avatar on login so it's cached before profile screen
  const prefetchAvatar = useCallback((email) => {
    if (!email) return;
    try {
      const url = api.getAvatarUrlForEmail(email);
      if (!url) return;
      if (Platform.OS === 'web') {
        // Browser will cache the response (24h Cache-Control)
        const img = new window.Image();
        img.src = url;
      } else {
        // expo-image has built-in prefetch with disk caching
        import('expo-image').then(({ Image }) => {
          if (Image.prefetch) Image.prefetch(url);
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const login = useCallback(async (email, password) => {
    const r = await api.login(email, password);
    if (r.success && !r.data?.requires_verification) {
      // Clear old cache before setting new user
      await clearAllCache();
      const clearChatCache = await getLazyClearChatCache(); await clearChatCache();
      setCacheUser(r.data?.email || email);
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
      prefetchAvatar(r.data?.email || email);
      prefetchProfile(r.data?.email || email);
      // Initial sync — download everything to SQLite (WhatsApp-style)
      try {
      } catch {}
      // Set child status from login response
      if (r.data?.is_child) {
        _childRestrictions = r.data.child_restrictions || {};
      } else {
        _childRestrictions = null;
      }
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth, prefetchAvatar, prefetchProfile]);

  const completeLoginAfterChallenge = useCallback(async (data) => {
    if (data?.token) {
      api.setAuthTokenDirect(data.token);
    }
    if (data?.device_trust_token) {
      api.saveTrustToken(data.device_trust_token);
    }
    await clearAllCache();
    const _clearChat = await getLazyClearChatCache(); await _clearChat();
    setCacheUser(data?.email);
    setUser(data);
    loadAccounts();
    registerPushAfterAuth();
  }, [loadAccounts, registerPushAfterAuth]);

  // QR login: set token + user state, then verify with server
  const loginWithToken = useCallback(async (authToken, email) => {
    api.setAuthTokenDirect(authToken);
    const name = (typeof email === "string" && email) ? email.split('@')[0] : '';
    api.upsertAccount(email, '', name);
    api.setActiveAccountEmail(email);
    await clearAllCache();
    const _clearChat2 = await getLazyClearChatCache(); await _clearChat2();
    setCacheUser(email);
    // Set user immediately so auth guards don't redirect
    setUser({ email, name });
    loadAccounts();
    registerPushAfterAuth();
    // Verify with server in background to get full user data
    try {
      const r = await api.checkAuth();
      if (r.success && r.data?.email) {
        setUser(r.data);
        if (r.data.is_child) {
          _childRestrictions = r.data.child_restrictions || {};
        }
      }
    } catch {}
  }, [loadAccounts, registerPushAfterAuth]);

  const signup = useCallback(async (username, password, name, domain) => {
    const r = await api.signup(username, password, name, domain);
    if (r.success) {
      await clearAllCache();
      const clearChatCache = await getLazyClearChatCache(); await clearChatCache();
      setCacheUser(r.data?.email);
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth]);

  const doLogout = useCallback(async () => {
    // Stop child location tracking
    _childRestrictions = null;
    if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
    // 1. Clear user state FIRST (instant visual feedback)
    setUser(null);
    setCacheUser(null);
    // 2. Redirect to login IMMEDIATELY
    try { router.replace('/login'); } catch {}
    // 3. Clear token FIRST (prevents auto-relogin on next open)
    api.clearAuthToken();
    // 3a. Wipe biometric credentials so a different person on the same
    //     device can't Face/Touch ID their way back into the previous
    //     account. Native only — SecureStore doesn't exist on web.
    try {
      if (Platform.OS !== 'web') {
        const SecureStore = require('expo-secure-store');
        SecureStore.deleteItemAsync('bio_email').catch(() => {});
        SecureStore.deleteItemAsync('bio_token').catch(() => {});
        SecureStore.deleteItemAsync('bio_password').catch(() => {}); // legacy cleanup
      }
    } catch {}
    // 4. Tear down background services so the NEXT account doesn't inherit
    //    WebSocket listeners, MQTT subscriptions, push registrations, or the
    //    edge-detection interval from the previous user.
    try { api.stopEdgeDetection?.(); } catch {}
    try {
      const ws = require('../services/websocket').default;
      ws?.disconnect?.();
      // Clear any stray listeners so callbacks from account A don't fire
      // after account B logs in.
      if (ws?.listeners && typeof ws.listeners.forEach === 'function') {
        try { ws.listeners.forEach((set) => set?.clear?.()); } catch {}
      }
    } catch {}
    try { require('../services/mqtt').default?.disconnect?.(); } catch {}
    try { require('../services/tcpChat').default?.disconnect?.(); } catch {}
    try {
      const push = require('../services/pushNotifications');
      push?.unregisterPushToken?.().catch(() => {});
    } catch {}
    // 5. Server-side logout (best-effort)
    api.logout().catch(() => {});
    clearAllCache().catch(() => {});
    getLazyClearChatCache().then(fn => fn()).catch(() => {});
  }, []);

  // Switch to a different stored account using bearer token
  const switchAccount = useCallback(async (email) => {
    const stored = api.getStoredAccounts();
    const account = stored.find(a => a.email === email);
    if (!account) return { success: false, message: 'Account not found' };

    setSwitching(true);
    try {
      // If we have a stored token, try it FIRST before logging out current session
      if (account.token) {
        // Save current token in case we need to restore it
        const previousToken = api.getAuthToken();

        // Try the stored token — server will switch session if bearer is for a different user
        api.setAuthTokenDirect(account.token);
        try {
          const check = await api.checkAuth();
          if (check.success && check.data?.email) {
            // Verify the server returned the TARGET account (not the old session)
            const normalize = (e) => (e || '').toLowerCase().replace('@onemundo.com.br', '@chatyy.com.br');
            if (normalize(check.data.email) !== normalize(email)) {
              // Server returned old session user — token may be for wrong account
              if (previousToken) api.setAuthTokenDirect(previousToken);
              return { success: false, message: 'Session expired, please login again' };
            }
            // Token valid - clear caches and switch
            try { await clearAllCache(); } catch {}
            try { await clearChatCache(); } catch {}
            setCacheUser(check.data.email);
            setUser(check.data);
            // Update active account marker
            api.setActiveAccountEmail(check.data.email);
            // Update stored token (server may have rotated it)
            const currentToken = api.getAuthToken();
            if (currentToken) {
              api.upsertAccount(check.data.email, null, check.data.name || check.data.email);
            }
            loadAccounts();
            prefetchAvatar(check.data.email);
            prefetchProfile(check.data.email);
            return { success: true, data: check.data };
          }
        } catch {
          // checkAuth failed (network error etc.)
        }

        // Token expired or error - restore previous session so user stays logged in
        if (previousToken) {
          api.setAuthTokenDirect(previousToken);
        }
      }
      // Token expired — user needs to re-login (don't logout current session)
      return { success: false, message: 'Session expired, please login again' };
    } finally {
      setSwitching(false);
    }
  }, [loadAccounts, user, prefetchAvatar, prefetchProfile]);

  // Remove a stored account
  const removeAccount = useCallback((email) => {
    api.removeStoredAccount(email);
    loadAccounts();
    // If removing the active account, logout
    if (user?.email === email) {
      doLogout();
    }
  }, [user, doLogout, loadAccounts]);

  // Listen for auth failure signal from api.js (token rejected server-side).
  // This fires on iOS when the stored Bearer token expired and no password is
  // in memory to re-login. Force redirect to /login so user can re-authenticate
  // instead of seeing the offline/wifi-off icon forever.
  useEffect(() => {
    const handleAuthFailure = () => {
      console.warn('[auth] Token rejected — forcing logout');
      try { api.resetAuthFailureSignal?.(); } catch {}
      doLogout();
    };
    try {
      if (typeof globalThis !== 'undefined' && globalThis.addEventListener) {
        globalThis.addEventListener('chatyy:authFailure', handleAuthFailure);
        return () => {
          try { globalThis.removeEventListener('chatyy:authFailure', handleAuthFailure); } catch {}
        };
      }
      // React Native fallback: poll the global flag
      const iv = setInterval(() => {
        if (globalThis.__chatyy_authFailure && globalThis.__chatyy_authFailure > (Date.now() - 10000)) {
          globalThis.__chatyy_authFailure = 0;
          handleAuthFailure();
        }
      }, 2000);
      return () => clearInterval(iv);
    } catch {}
  }, [doLogout]);

  // Allow profile screen to update user data (e.g., name) without full re-auth
  const updateUser = useCallback((updates) => {
    setUser(prev => prev ? { ...prev, ...updates } : prev);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const r = await api.checkAuth();
      if (r?.success && r.data?.email) setUser(r.data);
      return r;
    } catch { return null; }
  }, []);

  // Memoize context value to prevent re-renders in all consumers on every
  // internal state change (e.g. `switching` flag during account swap).
  const contextValue = useMemo(() => ({
    user, loading, login, signup, logout: doLogout,
    accounts, switchAccount, removeAccount, switching,
    completeLoginAfterChallenge, loginWithToken, updateUser, refreshAuth,
  }), [user, loading, login, signup, doLogout, accounts, switchAccount, removeAccount, switching,
      completeLoginAfterChallenge, loginWithToken, updateUser, refreshAuth]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
