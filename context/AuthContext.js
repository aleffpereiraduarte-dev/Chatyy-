import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import * as api from '../services/api';

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
          setUser(r.data);
          loadAccounts();
          setLoading(false);
          return;
        }

        // Session expired — try re-login with saved credentials
        const creds = getSavedCredentials();
        if (creds?.email && creds?.password) {
          const lr = await api.login(creds.email, creds.password);
          if (lr.success) {
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

  const login = useCallback(async (email, password) => {
    const r = await api.login(email, password);
    if (r.success) {
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth]);

  const signup = useCallback(async (username, password, name, domain) => {
    const r = await api.signup(username, password, name, domain);
    if (r.success) {
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth]);

  const doLogout = useCallback(async () => {
    try { await api.logout(); } catch {}
    setUser(null);
  }, []);

  // Switch to a different stored account using bearer token
  const switchAccount = useCallback(async (email) => {
    const stored = api.getStoredAccounts();
    const account = stored.find(a => a.email === email);
    if (!account) return { success: false, message: 'Account not found' };

    setSwitching(true);
    try {
      // Logout current session
      try { await api.logout(); } catch {}
      setUser(null);

      // If we have a stored token, restore it and check auth
      if (account.token) {
        api.setAuthTokenDirect(account.token);
        const check = await api.checkAuth();
        if (check.success && check.data?.email) {
          setUser(check.data);
          loadAccounts();
          return { success: true, data: check.data };
        }
      }
      // Token expired — user needs to re-login
      return { success: false, message: 'Session expired, please login again' };
    } finally {
      setSwitching(false);
    }
  }, [loadAccounts]);

  // Remove a stored account
  const removeAccount = useCallback((email) => {
    api.removeStoredAccount(email);
    loadAccounts();
    // If removing the active account, logout
    if (user?.email === email) {
      doLogout();
    }
  }, [user, doLogout, loadAccounts]);

  return (
    <AuthContext.Provider value={{
      user, loading, login, signup, logout: doLogout,
      accounts, switchAccount, removeAccount, switching,
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
