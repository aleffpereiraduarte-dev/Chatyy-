import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Platform, AppState } from 'react-native';
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

// Fetch the latest restrictions from the server (parent may have changed
// bedtime, contact whitelist, etc. while the child app was open).
// Idempotent and safe to call from anywhere — used by ChildRestrictionGuard
// and the AppState listener below.
let _refreshingChild = null;
export async function refreshChildRestrictions() {
  if (_refreshingChild) return _refreshingChild;
  _refreshingChild = (async () => {
    try {
      const r = await api.parentalMyStatus();
      if (r?.success && r?.data?.is_child) {
        _childRestrictions = r.data.restrictions || {};
        return true;
      }
      _childRestrictions = null;
      return false;
    } catch { return false; }
  })().finally(() => { _refreshingChild = null; });
  return _refreshingChild;
}

function getSavedCredentials() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const c = localStorage.getItem('mail_creds');
      return c ? JSON.parse(c) : null;
    }
  } catch {}
  return null;
}

// Aggressively wipe every per-account cache on the device. Goes well beyond
// `clearAllCache()` (which only touches MMKV @chatyy_cache_*) and `clearChatCache()`
// (which only resets the chat SQLite/in-memory layer). Catches AsyncStorage
// keys written by individual screens (chat drafts, chat lock passwords,
// effects-seen flags, e2e banner dismissed flags, per-conv notif sound prefs,
// premium flag, offline user blob, etc.) plus the web localStorage twins.
//
// We KEEP a small allowlist of device-level prefs that are safe to share
// across users: theme, locale, language picker, biometric availability flag,
// the multi-account roster, and the bio_email/bio_token pair (Face ID for
// the LAST user — already gated by device biometric).
async function clearAllPerAccountCaches() {
  // 1. Standard MMKV cache + chat-cache module (lazy to break cycle)
  try { await clearAllCache(); } catch {}
  try { const fn = await getLazyClearChatCache(); await fn(); } catch {}

  // 2. AsyncStorage sweep — anything that smells user-scoped
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const KEEP_PREFIXES = [
      'bio_email', 'bio_token', 'theme', 'locale',
      'biometric_enabled', 'language', 'mail_accounts',
    ];
    const isKept = (k) => KEEP_PREFIXES.some(p => k.startsWith(p));
    const toRemove = allKeys.filter(k => {
      if (isKept(k)) return false;
      // chat_*           → chat_draft_*, chat_notif_sound_*, chatLockKey
      // chatyy:*         → chatyy:effect_seen:*
      // chatyy_*         → chatyy_premium, chatyy_convs_v1, chatyy_offline_user
      // e2e_*            → e2e_banner_dismissed_*
      // mail_* (non-kept)→ mail_token, mail_active_account, etc.
      // media_*, feed_*, presence_*, typing_*, outbox_*  → various
      return (
        k.startsWith('chat_') ||
        k.startsWith('chatyy:') ||
        k.startsWith('chatyy_') ||
        k.startsWith('e2e_') ||
        (k.startsWith('mail_') && !isKept(k)) ||
        k.startsWith('media_') ||
        k.startsWith('feed_') ||
        k.startsWith('presence_') ||
        k.startsWith('typing_') ||
        k.startsWith('outbox_')
      );
    });
    if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  } catch {}

  // 3. Web localStorage equivalents (chatyy_convs_v1 + any browser-only state)
  try {
    if (typeof localStorage !== 'undefined') {
      const remove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (
          k.startsWith('chat_') || k.startsWith('chatyy_') || k.startsWith('e2e_') ||
          k.startsWith('media_') || k.startsWith('feed_') || k.startsWith('outbox_')
        ) {
          remove.push(k);
        }
      }
      remove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    }
  } catch {}
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

  // Sync the current bearer token + base URL into the App Group so the
  // native iOS ShareExtension UI can post on the user's behalf. Idempotent
  // and silent on failure (Android / web all no-op). Called whenever the
  // user state lands at "logged in" — fresh login, hydrate-from-cache,
  // refetch-with-saved-creds, etc.
  const _syncShareExtAuth = useCallback((email) => {
    try {
      if (Platform.OS !== 'ios') return;
      const tok = (api.getAuthToken?.() || '').toString();
      if (!tok) return;
      const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
      const e = (email || '').toString().toLowerCase();
      const { Intents } = require('../modules/expo-native-toolkit');
      Intents.setShareExtensionAuth(tok, e, baseUrl);
    } catch {}
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
              _syncShareExtAuth(userData.email);
              setLoading(false);
              return true;
            }
          }
        } catch {}
        // Last resort: only resurrect if there's an *active* account marker.
        // Previously this fell back to `accts[0]` which auto-logged the user
        // back in on cold start even after explicit logout (active was
        // cleared but accts[0] resurrected anyway). After logout we now
        // clear active to '' (see doLogout step 3b.1) so this branch fails
        // and the user lands on /login as intended.
        try {
          const active = api.getActiveAccountEmail?.() || '';
          if (active) {
            const accts = api.getStoredAccounts?.() || [];
            const a = accts.find(x => x.email === active);
            if (a?.email) {
              setUser({ email: a.email, name: a.name || a.email.split('@')[0] });
              loadAccounts();
              setLoading(false);
              return true;
            }
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
        // Detect explicit server-side auth rejection (401) vs a network error.
        // Previously both fell through to `hydrateOffline()` at the bottom —
        // that loaded the last cached user from AsyncStorage even when the
        // server had explicitly invalidated the session, leaving the user
        // on /chat with every API call returning 401 and no conversations
        // (the "já abre chatyy sem conversas" bug). On a true 401 we want
        // the login screen, not a ghost-logged-in state.
        const serverRejectedAuth = !r?.success && typeof r?.message === 'string' && (
          /not.*authenticated|session.*expired|invalid.*token|unauthor/i.test(r.message)
        );
        if (r.success && r.data?.email) {
          setCacheUser(r.data.email);
          setUser(r.data);
          // Cache user data for offline access (WhatsApp-style)
          if (Platform.OS !== 'web') {
            AsyncStorage.setItem('chatyy_offline_user', JSON.stringify(r.data)).catch(() => {});
          }
          loadAccounts();
          _syncShareExtAuth(r.data.email);
          prefetchAvatar(r.data.email);
          prefetchProfile(r.data.email);
          // Idempotent: re-register the user's verified phone so they stay
          // discoverable to anyone who had the number in their contacts. Runs
          // on every app-open (fire-and-forget, 800ms timeout server-side).
          if (r.data.phone || r.data.verified_phone) {
            setTimeout(() => {
              try {
                const { registerOwnPhone } = require('../services/contactSync');
                registerOwnPhone(r.data.verified_phone || r.data.phone).catch(() => {});
              } catch {}
            }, 2500);
          }
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
            _syncShareExtAuth(lr.data?.email || creds.email);
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
            _syncShareExtAuth(creds.email);
            setLoading(false);
            return;
          }
        }

        // Final fallback: try offline cache before kicking to login.
        // This rescues users who don't have an in-memory password (most
        // returning users after an app restart) — but ONLY if we don't
        // already know the server rejected their auth. If the server said
        // "Not authenticated", don't pretend they're still logged in
        // (that's what caused users to land on /chat with empty convs).
        if (!serverRejectedAuth && await hydrateOffline()) return;

        // Server rejected boot-time auth on web. Wipe every stored token so
        // the next fetch (that may already be in flight from app-level
        // prefetches) doesn't spam /inbox with 401s using a dead token.
        // localStorage.removeItem is synchronous — safe to do here before
        // any React effect fires.
        if (serverRejectedAuth && Platform.OS === 'web' && typeof localStorage !== 'undefined') {
          try {
            localStorage.removeItem('mail_token');
            localStorage.removeItem('mail_active_account');
            localStorage.removeItem('device_trust_token');
          } catch {}
          try { api.clearAuthToken?.(); } catch {}
        }
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

  // Pull fresh restrictions whenever the app comes back to the foreground
  // — parent might have changed bedtime / contact whitelist / disabled chat
  // while the kid had the app suspended. Without this they keep the stale
  // policy until next cold-start, which defeats the whole control model.
  useEffect(() => {
    let lastFetch = 0;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // Throttle: don't refetch more than once per 30s.
      const now = Date.now();
      if (now - lastFetch < 30_000) return;
      if (!isChildAccount()) return;
      lastFetch = now;
      refreshChildRestrictions().catch(() => {});
    });
    return () => sub?.remove?.();
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
        // Limpa o tracking se o usuário deixou de ser child entre cargas
        // — antes o interval continuava enviando localização indevidamente.
        if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
      }
    } catch (e) {
      console.warn('[parental] Status check failed:', e?.message);
      _childRestrictions = null;
      if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
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

  // Belt-and-suspenders: sync the bearer token + base URL to the App Group
  // every time the user state lands on a truthy email. Covers every path —
  // login, hydrate-from-cache, Face ID, QR pair, refetch — without having
  // to remember to call _syncShareExtAuth at every site. Runs on every
  // user change so token refreshes also propagate.
  useEffect(() => {
    if (user?.email) _syncShareExtAuth(user.email);
  }, [user?.email, _syncShareExtAuth]);

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
      // Re-arm the auto-logout guard so a future token expiry on THIS
      // session routes to /login again (flag is once-per-process).
      try { api.resetAuthFailureSignal?.(); } catch {}
      await clearAllCache();
      const clearChatCache = await getLazyClearChatCache(); await clearChatCache();
      setCacheUser(r.data?.email || email);
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
      prefetchAvatar(r.data?.email || email);
      prefetchProfile(r.data?.email || email);
      // A user who can log in already has an account — they're not new to
      // Chatyy and shouldn't see the splash onboarding tour. Mark both keys
      // so a fresh browser/device skips the tutorial after sign-in. Without
      // this, a user logging in on web for the first time gets the tour
      // overlay rendered on top of /inbox.
      try {
        await AsyncStorage.setItem('onboarding_complete', '1');
        await AsyncStorage.setItem('@chatyy_onboarding_done', 'true');
      } catch {}
      // Push the bearer token + base URL into the App Group so the
      // native iOS ShareExtension UI can call the Chatyy API on the
      // user's behalf without bouncing through the React Native app.
      try {
        if (Platform.OS === 'ios') {
          const { Intents } = require('../modules/expo-native-toolkit');
          const tok = (r.data?.token || api.getAuthToken?.() || '').toString();
          const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
          const userEmail = (r.data?.email || email || '').toString().toLowerCase();
          if (tok) Intents.setShareExtensionAuth(tok, userEmail, baseUrl);
        }
      } catch {}
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
    // Reset the "once-per-session" auth-failure guard so if THIS new token
    // expires later, the redirect-to-login fires again. Without this, a
    // second expiry in the same session silently swallows 401s.
    try { api.resetAuthFailureSignal?.(); } catch {}
    await clearAllCache();
    const _clearChat = await getLazyClearChatCache(); await _clearChat();
    setCacheUser(data?.email);
    setUser(data);
    loadAccounts();
    registerPushAfterAuth();
  }, [loadAccounts, registerPushAfterAuth]);

  // Log in using a previously-saved bearer token (QR flow, biometric flow).
  // Validates the token via /check_auth BEFORE mutating user state so a
  // stale/revoked token doesn't look like a successful login. Returns a
  // {success, data, message?} object matching the shape of login().
  const loginWithToken = useCallback(async (authToken, email) => {
    api.setAuthTokenDirect(authToken);
    // Verify first — if the server rejects the token, undo the token set
    // and return a failure so the caller can advance to the password step
    // instead of leaving the user in a half-logged-in zombie state.
    let verified;
    try {
      verified = await api.checkAuth();
    } catch {
      verified = { success: false, message: 'verify failed' };
    }
    if (!verified?.success || !verified?.data?.email) {
      api.clearAuthToken();
      return { success: false, message: verified?.message || 'Token invalid' };
    }

    // Re-arm the "once-per-process" auth-failure guard. Without this, if
    // this session's new token expires later, the global 401 handler
    // silently swallows it (guard was still `true` from a previous expiry)
    // — user sees empty chat instead of being redirected to /login, then
    // has to logout manually. login() and completeLoginAfterChallenge()
    // already do this; mirrored here so Face ID re-login behaves the same.
    try { api.resetAuthFailureSignal?.(); } catch {}

    const data = verified.data;
    const name = data.name || (typeof email === 'string' && email ? email.split('@')[0] : '');
    // Compute isAccountSwitch BEFORE upsertAccount / setActiveAccountEmail —
    // those mutate the "active email" and would make prev==new always.
    const newEmail = (data.email || email || '').toLowerCase();
    const prevEmail = (api.getActiveAccountEmail?.() || '').toLowerCase();
    const isAccountSwitch = !!prevEmail && prevEmail !== newEmail;
    // Use o token recém-validado em vez de '' — antes salvava string vazia
    // e quebrava o reuso do token nas trocas de conta seguintes.
    api.upsertAccount(data.email || email, api.getAuthToken?.() || '', name);
    api.setActiveAccountEmail(data.email || email);
    // Wipe the local cache whenever the bearer-token login lands on a
    // potentially different identity:
    //   • isAccountSwitch — explicit prev≠new (classic account switch).
    //   • !prevEmail      — no active session (cold start, or right after
    //     logout). Critical for fresh signup: phone_signup → loginWithToken
    //     comes in here with prevEmail='', so without this the new user
    //     would inherit the old user's chat drafts, conversations cache,
    //     effect-seen flags, etc. Privacy bug (#"criou nova conta e puxou
    //     todas as conversas do cache do celular").
    // The "preserve cache for Face ID re-login of same user" optimization
    // still applies — that path always has prevEmail set AND prev==new.
    const shouldNuke = isAccountSwitch || !prevEmail;
    if (shouldNuke) {
      await clearAllPerAccountCaches();
    }
    setCacheUser(data.email || email);
    setUser(data);
    if (data.is_child) {
      _childRestrictions = data.child_restrictions || {};
    }
    loadAccounts();
    registerPushAfterAuth();
    return { success: true, data };
  }, [loadAccounts, registerPushAfterAuth]);

  const signup = useCallback(async (username, password, name, domain) => {
    const r = await api.signup(username, password, name, domain);
    if (r.success) {
      // Defense-in-depth: signup creates a brand new account, so wipe ALL
      // per-account state from any previous user that may have used this
      // device. clearAllCache() alone only touches MMKV — it leaves
      // AsyncStorage chat drafts, chat locks, premium flag, etc. behind.
      await clearAllPerAccountCaches();
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

    // CRITICAL: revoke the device's push token server-side BEFORE clearing
    // the bearer token. Previously this ran AFTER `api.clearAuthToken()` —
    // backend got 401 from the unauthenticated API call, the token file
    // was never updated, and the device kept receiving pushes for the
    // logged-out account. Now we await the unregister call (with a short
    // timeout) so the bearer token is still attached to the request.
    try {
      const push = require('../services/pushNotifications');
      let tok = null;
      try { tok = push?.getCachedPushToken?.() || null; } catch {}
      // Call removeTokenFromBackend regardless of `tok` — when no cached
      // token is available it falls back to unregister_all_my_push_tokens
      // which wipes the user's tokens.json server-side. This closes the
      // privacy hole where a logged-out device kept getting pushes (e.g.
      // logging out of your account from a friend's phone).
      if (push?.removeTokenFromBackend) {
        // Race the network call against a 2s timeout so a slow backend
        // can't block the logout UI — but we DO wait for it when the
        // network is healthy, which is the common case.
        await Promise.race([
          push.removeTokenFromBackend(tok).catch(() => {}),
          new Promise(r => setTimeout(r, 2000)),
        ]);
      }
    } catch {}

    // 1. Clear user state (instant visual feedback)
    const _outgoingEmail = (user?.email || api.getActiveAccountEmail?.() || '').toLowerCase();
    setUser(null);
    setCacheUser(null);
    // 2. Redirect to login IMMEDIATELY
    try { router.replace('/login'); } catch {}
    // 3. Clear token (prevents auto-relogin on next open) — must happen
    //    AFTER the push-token revoke above so the API call had auth.
    //    AWAIT the async variant on native so SecureStore.deleteItemAsync
    //    completes before the user can kill the app from the app switcher.
    //    The previous fire-and-forget clearAuthToken() left a window where
    //    a fast app-kill skipped the keychain delete, and next cold-start's
    //    line 422 IIFE re-hydrated `authToken` from the stale entry —
    //    checkAuth() then succeeded and the user was auto-logged-back-in
    //    (reported 2026-05-07).
    try { await api.clearAuthTokenAsync(); } catch { try { api.clearAuthToken(); } catch {} }
    // 3b. Clear the offline user cache so the next app-open's
    //     hydrateOffline() doesn't resurrect a logged-out session.
    //     Without this, users who got kicked for a 401 would still see
    //     themselves as "logged in" on next cold start.
    try { await AsyncStorage.removeItem('chatyy_offline_user'); } catch {}
    // 3b.1. Clear the active-account marker too — also awaited on native
    //       (same race-window fix as the bearer above). hydrateOffline()
    //       has a last-resort fallback that reads getActiveAccountEmail()
    //       and picks accts[0] when no offline cache exists. Without
    //       clearing active, the user gets auto-logged-in on next cold
    //       start even though they explicitly logged out (reported
    //       2026-05-07: "saiu da conta, fechou o app, abriu, voltou pra
    //       conta"). The stored accounts list is preserved so
    //       multi-account / Face ID still work — only the *currently
    //       active* marker is cleared so the fallback can't resurrect
    //       this session.
    try { await api.setActiveAccountEmailAsync?.(''); } catch { try { api.setActiveAccountEmail?.(''); } catch {} }
    // 3b.2. Wipe the bearer token from the multi-account row for THIS
    //       user — accounts list keeps email+name so the next sign-in
    //       can pre-fill the picker, but the token field is zeroed so
    //       even a pathological switchAccount-without-OTP path can't
    //       reuse a logged-out session's bearer.
    try { if (_outgoingEmail) await api.clearStoredAccountTokenAsync?.(_outgoingEmail); } catch {}
    // 3a. KEEP bio_email + bio_token across logout so "Entrar com Face ID"
    //     ainda aparece na próxima vez que o user abrir o login — WhatsApp
    //     pattern. O Face ID local já protege contra outra pessoa entrar
    //     (precisa validar a face/digital do dono do device). Só limpamos o
    //     legacy bio_password. O fluxo explícito de "Esquecer este dispositivo"
    //     fica nas Configurações (a ser adicionado no futuro).
    try {
      if (Platform.OS !== 'web') {
        const SecureStore = require('expo-secure-store');
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
    // Local-only push cleanup (clears notification badge, dismisses any
    // pending local notifications). The server-side revoke already ran
    // above before the bearer token got cleared.
    try {
      const push = require('../services/pushNotifications');
      push?.unregisterPushToken?.().catch(() => {});
    } catch {}
    // 5. Server-side logout (best-effort) — wraps up server session
    api.logout().catch(() => {});
    // Aggressive nuke AFTER the logout chain finishes — clearAllCache only
    // wipes MMKV, but AsyncStorage chat drafts / chatLockKey / effect-seen /
    // premium flag would leak into the next account that signs in on this
    // device. Run async so logout UI navigation is not blocked.
    clearAllPerAccountCaches().catch(() => {});
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
            // Token valid - clear caches and switch.
            // CRITICAL: reset the WS too so listeners + subscriptions from
            // the previous account don't fire into the new one. Without
            // this, Account A's chat_summary events would land on Account
            // B's state (cross-account leak).
            try {
              const ws = require('../services/websocket').default;
              ws?.disconnect?.();
              ws?.reset?.(true); // fullWipe=true on account switch
            } catch {}
            try { await clearAllCache(); } catch {}
            try { await clearChatCache(); } catch {}
            setCacheUser(check.data.email);
            setUser(check.data);
            // Update active account marker
            api.setActiveAccountEmail(check.data.email);
            // Update stored token (server may have rotated it)
            // Persiste o token atual — antes passava `null` e apagava o
            // token armazenado, quebrando troca de conta sem re-login.
            const currentToken = api.getAuthToken();
            if (currentToken) {
              api.upsertAccount(check.data.email, currentToken, check.data.name || check.data.email);
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
  // This fires when any API call gets a 401 and no saved password is in
  // memory to re-login. Force redirect to /login so the user can re-auth
  // instead of seeing empty screens / having to manually logout.
  //
  // We register BOTH paths — the event listener (works on web + modern RN
  // with EventTarget) AND the global-flag polling — because in production
  // we've seen the event dispatch silently no-op on some RN builds and
  // users got stuck on an empty chat screen until they clicked Sair.
  useEffect(() => {
    let _handled = 0;
    const handleAuthFailure = () => {
      if (Date.now() - _handled < 1500) return; // debounce duplicate fires
      _handled = Date.now();
      console.warn('[auth] Token rejected — forcing logout');
      try { api.resetAuthFailureSignal?.(); } catch {}
      doLogout();
    };
    let removeListener = () => {};
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('chatyy:authFailure', handleAuthFailure);
        removeListener = () => {
          try { globalThis.removeEventListener('chatyy:authFailure', handleAuthFailure); } catch {}
        };
      }
    } catch {}
    // Always-on polling: catches cases where dispatchEvent silently no-ops
    // (e.g. React Native builds where EventTarget exists but Event doesn't
    // actually reach registered listeners — observed as "chat empty after
    // token expiry, only fixes after Sair").
    const iv = setInterval(() => {
      if (globalThis.__chatyy_authFailure && globalThis.__chatyy_authFailure > (Date.now() - 10000)) {
        globalThis.__chatyy_authFailure = 0;
        handleAuthFailure();
      }
    }, 1500);
    return () => { removeListener(); clearInterval(iv); };
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
