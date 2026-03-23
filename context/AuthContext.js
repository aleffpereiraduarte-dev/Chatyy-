import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import * as api from '../services/api';
import { clearAll as clearAllCache, setCacheUser } from '../services/cache';
import { clearChatCache } from '../services/chatCache';

const AuthContext = createContext(null);

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
    try { await api.logout(); } catch {}
    // Clear all caches to prevent data leaking to next account
    await clearAllCache();
    await clearChatCache();
    setCacheUser(null);
    setUser(null);
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
            if (check.data.email !== email) {
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
      completeLoginAfterChallenge, updateUser,
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
