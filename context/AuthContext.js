import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as api from '../services/api';
import { clearAll as clearAllCache, setCacheUser } from '../services/cache';
import { clearChatCache } from '../services/chatCache';

const AuthContext = createContext(null);

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
      try {
        // First try: check if server session is still alive
        const r = await api.checkAuth();
        if (r.success && r.data?.email) {
          setCacheUser(r.data.email);
          setUser(r.data);
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
      } catch (e) {
        // Network error - try to use cached credentials
        const creds = getSavedCredentials();
        if (creds?.email) {
          setUser({ email: creds.email, name: creds.email.split('@')[0] });
          loadAccounts();
          setLoading(false);
          return;
        }
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
  let _locationInterval = null;
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
      await clearChatCache();
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
    await clearChatCache();
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
    await clearChatCache();
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
      await clearChatCache();
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
    // 4. Cleanup in background
    api.logout().catch(() => {});
    clearAllCache().catch(() => {});
    clearChatCache().catch(() => {});
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

  // Allow profile screen to update user data (e.g., name) without full re-auth
  const updateUser = useCallback((updates) => {
    setUser(prev => prev ? { ...prev, ...updates } : prev);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, loading, login, signup, logout: doLogout,
      accounts, switchAccount, removeAccount, switching,
      completeLoginAfterChallenge, loginWithToken, updateUser,
      refreshAuth: async () => {
        try {
          const r = await api.checkAuth();
          if (r?.success && r.data?.email) setUser(r.data);
          return r;
        } catch { return null; }
      },
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
