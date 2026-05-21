import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Platform, AppState, Modal, View, Text, Pressable, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import * as api from '../services/api';
import { clearAll as clearAllCache, setCacheUser } from '../services/cache';
import { initDeltaSync, stopDeltaSync } from '../services/deltaSync';

// Lazy-load to break circular dependency: AuthContext → chatCache → db
const getLazyClearChatCache = async () => {
  const { clearChatCache } = await import('../services/chatCache');
  return clearChatCache;
};

// Account-switch paint race: clearChatCache() is async, but React happily
// renders the new user's chat list BEFORE the clear resolves. Without
// gating, the sync getters in smartChatCache serve the previous user's
// blobs for 1-2 frames — visible as a flash of their conversations.
// lockCacheScope() makes every (sync + async) cache reader return empty
// for `ms` milliseconds; the new user's real fetch fills the screen
// instead of the stale one.
function _lockCacheScopeSync(ms = 500) {
  try {
    const mod = require('../services/chatCache');
    mod?.lockCacheScope?.(ms);
  } catch {}
}

const AuthContext = createContext(null);

// Module-level interval ref so it persists across re-renders
let _locationInterval = null;

// Module-level state for the first-launch cloud-restore prompt. Set to a
// truthy object after a successful first-time login when the user does not
// yet carry the `chatyy_restored_once` AsyncStorage flag. The chat list
// reads this via `consumeRestorePrompt()` and renders a fullscreen modal
// over itself; the user picks Restaurar or Começar do zero, which sets the
// flag so we never ask again.
let _restorePromptState = null;
const _restorePromptListeners = new Set();
function _notifyRestorePromptChange() {
  for (const fn of _restorePromptListeners) { try { fn(_restorePromptState); } catch {} }
}
export function getRestorePromptState() { return _restorePromptState; }
export function subscribeRestorePrompt(fn) {
  _restorePromptListeners.add(fn);
  return () => _restorePromptListeners.delete(fn);
}
export async function dismissRestorePrompt() {
  _restorePromptState = null;
  _notifyRestorePromptChange();
  try { await AsyncStorage.setItem('chatyy_restored_once', '1'); } catch {}
}
// Trigger after successful first-time login. Best-effort: if the existence
// probe fails or there are no backups, we silently set the flag and skip
// the prompt entirely. Only fires once per device — controlled by the
// `chatyy_restored_once` AsyncStorage key.
async function _maybeOfferCloudRestore() {
  try {
    const already = await AsyncStorage.getItem('chatyy_restored_once');
    if (already) return;

    // Bail-out 1: device already has chat data locally (chat.db / SQLite cache
    // populated, or any conversation in MMKV). Means the user already has a
    // working install — offering "Restore from cloud" would overwrite their
    // current data with a stale/older backup. Confirmed root-cause of the
    // "encontrei um backup nas nuvens com bug ao logar" report (2026-05-08):
    // user logged in on existing install and got the prompt from a stale
    // server-side backup row that doesn't match their current state.
    try {
      const hasLocalData = await AsyncStorage.getItem('chatyy_conv_state_v1');
      if (hasLocalData) {
        await AsyncStorage.setItem('chatyy_restored_once', '1');
        return;
      }
    } catch {}

    // Probe server for an actual backup. Defaults to "no" — only the explicit
    // confirmed "yes" branch fires the modal. Previous logic showed the
    // prompt on network errors (hasBackup === null), which is dangerous
    // because hitting "Restaurar" with no backup payload could wipe local
    // data via chatBackupRestore(null).
    let hasBackup = false;
    try {
      if (typeof api.chatBackupExists === 'function') {
        const r = await api.chatBackupExists();
        if (r?.success && r?.data?.exists === true) hasBackup = true;
      } else if (typeof api.chatBackupList === 'function') {
        const r = await api.chatBackupList();
        if (r?.success) {
          const list = r.data?.backups || r.data?.list || (Array.isArray(r.data) ? r.data : []);
          hasBackup = Array.isArray(list) && list.length > 0;
        }
      }
    } catch {
      // Network / API error → assume no backup, don't pester the user. Set
      // the flag so a transient outage on every cold start doesn't repeat
      // this probe on every subsequent launch.
    }

    // Always set the once-per-device flag so this only runs at most once,
    // regardless of the backup-existence outcome (prevents re-prompting if
    // the API returns inconsistent results across installs).
    try { await AsyncStorage.setItem('chatyy_restored_once', '1'); } catch {}

    if (!hasBackup) return;
    _restorePromptState = { visible: true };
    _notifyRestorePromptChange();
  } catch {}
}

// What's-New tour state — exposed via subscribe pattern so any screen can
// react to "hey, we just upgraded the app and the user is now logged in."
// AuthProvider sets this to true after a successful login lands when the
// stored chatyy_whatsnew_v2_5_0 flag is missing AND chatyy_last_seen_version
// is set (= existing user). The WhatsNewGate component in _layout.js
// subscribes here so it can pop the sheet without each consumer re-running
// the AsyncStorage probe.
let _whatsNewState = false;
const _whatsNewListeners = new Set();
function _notifyWhatsNewChange() {
  for (const fn of _whatsNewListeners) { try { fn(_whatsNewState); } catch {} }
}
export function getWhatsNewState() { return _whatsNewState; }
export function subscribeWhatsNew(fn) {
  _whatsNewListeners.add(fn);
  return () => _whatsNewListeners.delete(fn);
}
export function setWhatsNewState(v) {
  _whatsNewState = !!v;
  _notifyWhatsNewChange();
}
async function _maybeOfferWhatsNew() {
  try {
    const dismissed = await AsyncStorage.getItem('chatyy_whatsnew_v2_5_0');
    if (dismissed === 'true') return;
    const lastSeen = await AsyncStorage.getItem('chatyy_last_seen_version');
    // Cold install: bookmark version, never show on first run.
    if (!lastSeen) {
      try { await AsyncStorage.setItem('chatyy_last_seen_version', '2.5.0'); } catch {}
      return;
    }
    if (lastSeen === '2.5.0') return;
    setWhatsNewState(true);
  } catch {}
}

// WhatsApp Web Sync — Stage 1 wiring. Boots the delta-sync engine + the
// foreground envelope puller as soon as we have a confirmed-good auth
// (cold-start hydrate, login, completeLoginAfterChallenge, loginWithToken).
// Idempotent because initDeltaSync() and startEnvelopePuller() are themselves
// idempotent (they short-circuit on re-entry). Failures are swallowed so a
// broken sync path doesn't block the user from getting into the app.
let _syncBooted = false;
function _bootSyncEngines() {
  if (_syncBooted) return;
  _syncBooted = true;
  try {
    initDeltaSync(api.apiCall, /* onChange */ () => {
      // Fan out to any listener that already wires to globalThis. The chat
      // list / inbox already poll their own data; this is just a nudge for
      // anyone who'd rather react than poll. Safe no-op when nothing is
      // listening.
      try {
        if (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function') {
          const Ev = (typeof Event === 'function') ? new Event('chatyy:syncTick') : null;
          if (Ev) globalThis.dispatchEvent(Ev);
        }
      } catch {}
    });
  } catch (e) {
    console.warn('[Auth] deltaSync init failed:', e?.message);
  }
  // [#1188 2026-05-19] KILL-SWITCH: envelope mode OFF. Receiver-side decrypt
  // has been failing silently — users report messages not arriving in real
  // time on Android+iOS even after multiple fix attempts. Falling back to
  // plaintext PHP send path (chat_messages + WS chat_message broadcast) which
  // ALWAYS worked. envelopePuller stays available behind setEnvelopeMode(true)
  // for opt-in testing. Restore by removing this block when decrypt is
  // proven stable end-to-end in QA.
  try { globalThis.__chatyy_envelope_mode = false; } catch {}
  // Don't start envelopePuller — there are no envelopes in plaintext mode.

  // [#1188 Agent H 2026-05-19] Publish this device's pubkey on EVERY auth.
  // Was previously called ONLY in QR-pair login (login.js:808 +
  // companion-qr.js:158) — meaning email login, phone signup, biometric
  // login, cold-start hydrate ALL skipped key publish. Result: any user
  // who never paired via QR has `chat_device_keys` empty → senders'
  // `chatEnvelopeSend` returns inserted:0 with success:true → optimistic
  // bubble flips ✓ but recipient gets NOTHING (silent black hole).
  // Idempotent server-side (UPSERT on email+device_id). Fire-and-forget.
  try {
    const { Platform } = require('react-native');
    const e2eMod = require('../services/e2e');
    Promise.all([e2eMod.getDeviceId?.(), e2eMod.getDevicePublicKey?.()])
      .then(([did, pub]) => {
        if (did && pub && typeof api.chatDeviceKeyPublish === 'function') {
          const kind = Platform.OS === 'web' ? 'web' : Platform.OS;
          api.chatDeviceKeyPublish(did, pub, kind).catch(() => {});
        }
      })
      .catch(() => {});
  } catch (e) {
    // e2e helpers may be absent on extremely old binaries; swallow.
  }
}

function _teardownSyncEngines() {
  _syncBooted = false;
  try { stopDeltaSync(); } catch {}
  try {
    const { abortFullHistorySync } = require('../services/fullHistorySync');
    abortFullHistorySync();
  } catch {}
  try {
    const { stopEnvelopePuller } = require('../services/envelopePuller');
    stopEnvelopePuller();
  } catch {}
  // Tear down global chat persistence listeners so a re-login attaches a
  // fresh set (idempotent + safe — startChatPersistence in _layout's
  // user-confirmed effect re-attaches them after auth).
  try {
    const { stopChatPersistence } = require('../services/chatPersistence');
    stopChatPersistence?.();
  } catch {}
}

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

// Surgical per-account cache cleaner. Targets ONLY the three bare-key MMKV
// leaks + one legacy localStorage key that demonstrably bleed across logins
// when the server response doesn't overwrite them for the new user:
//   • MMKV `chat_conversations` — written by services/api.js on login; if a
//     fresh account has zero conversations the previous user's blob stays.
//   • MMKV `omc_profile`        — cached profile blob (display name, avatar).
//   • MMKV `omc_call_history`   — call log persisted across sessions.
//   • localStorage `chatyy_convs_v1` (web) — legacy unscoped twin of the
//     user-scoped key now used by chat list.
// Deliberately does NOT touch:
//   • SQLite/localDb (would nuke outbox/pending_messages → broke Android send
//     during the 2026-05-11 aggressive-fix incident).
//   • AsyncStorage `u:*` keys (already user-scoped by key prefix).
//   • AsyncStorage `mail_*` keys (may include auth state / saved creds).
//   • SecureStore (bio_token etc).
async function clearAccountScopedMmkv() {
  try {
    const { remove: mmkvRemove } = require('../services/mmkv');
    mmkvRemove('chat_conversations');
    mmkvRemove('omc_profile');
    mmkvRemove('omc_call_history');
  } catch {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('chatyy_convs_v1');
    }
  } catch {}
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

  // 1b. Avatar disk cache (documentDirectory/avatar-saved). Avatars are
  // user-visible identifiers — leaving them on disk after logout lets
  // a stranger picking up the device see who the previous user chatted
  // with. Web no-ops (no documentDirectory equivalent).
  try {
    const { clearAvatarCache } = require('../services/avatarCache');
    await clearAvatarCache();
  } catch {}

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
      //
      // [WAVE 66 2026-05-21] Hydrate guard: after painting cached user,
      // kick a background HTTP check_auth. If it returns an *explicit*
      // 401/revoked we clear the cache and bounce to /login — this prevents
      // a zombie session where the offline cache survived a server-side
      // logout. Note: we do NOT clear on network errors (transient) — only
      // on a server response that *explicitly* says auth is dead.
      // Also: a successful hydrate kicks WS.resurrect() so the socket
      // doesn't sit in destroyed=true state until next watchdog tick.
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
              // [WAVE 66] Background revalidation. Bounded 8s timeout so a
              // genuinely offline launch never blocks. Only acts on an
              // *explicit* server rejection (not a network error).
              setTimeout(() => {
                Promise.race([
                  api.checkAuth().catch(() => null),
                  new Promise(r => setTimeout(() => r(null), 8000)),
                ]).then((r) => {
                  if (!r) return; // network/timeout — keep cached session
                  const explicitlyRejected = !r.success && typeof r.message === 'string' &&
                    /not.*authenticated|session.*expired|invalid.*token|unauthor|revoked|logged_out/i.test(r.message);
                  if (explicitlyRejected) {
                    // Cache is stale and server says session is dead.
                    // Don't clear if token is within 90-day grace (transient
                    // edge issue) — let the auth-failure handler decide.
                    if (api.isTokenWithinGracePeriod?.()) return;
                    try { console.warn('[auth] hydrate guard: server rejected cached session, forcing logout'); } catch {}
                    AsyncStorage.removeItem('chatyy_offline_user').catch(() => {});
                    doLogout('hydrate_guard_rejected');
                  } else if (r.success) {
                    // [WAVE 66] Token still valid — refresh cache + revive WS
                    // so it doesn't sit dead after a cold-start hydrate.
                    if (r.data) AsyncStorage.setItem('chatyy_offline_user', JSON.stringify(r.data)).catch(() => {});
                    try {
                      const ws = require('../services/websocket').default;
                      if (ws?.resurrect) ws.resurrect('hydrate_guard_revalidated');
                    } catch {}
                  }
                });
              }, 1500);
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
          try {
            const { setReporterIdentity, reportStep } = require('../services/crashReporter');
            const tok = (r.data?.token || api.getAuthToken?.() || '').toString();
            setReporterIdentity({ email: r.data.email, bearer: tok });
            reportStep('hydrate_checkAuth_ok', `email=${r.data.email}`);
          } catch {}
          // [#1175 2026-05-18] Persist bearer into native SharedPreferences
          // on cold-start hydrate. checkAuth succeeded → user has a valid
          // bearer in memory + storage; ensure LkTokenFetcher can find it
          // in the "expo_callkit_prefs" SharedPreferences for the next
          // incoming call.
          try {
            if (Platform.OS !== 'web') {
              const tok = (r.data?.token || api.getAuthToken?.() || '').toString();
              const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
              if (tok) {
                const mod = require('../modules/expo-callkit');
                const persist = mod?.persistAuthForNativeCall;
                if (typeof persist === 'function') {
                  persist(tok, baseUrl).catch(() => {});
                }
              }
            }
          } catch {}
          // Cache user data for offline access (WhatsApp-style)
          if (Platform.OS !== 'web') {
            AsyncStorage.setItem('chatyy_offline_user', JSON.stringify(r.data)).catch(() => {});
          }
          loadAccounts();
          _syncShareExtAuth(r.data.email);
          prefetchAvatar(r.data.email);
          prefetchProfile(r.data.email);
          // Wire the WhatsApp-Web style sync engines now that the token has
          // been validated by the server. Idempotent + try/catch'd inside so
          // a failure here can never prevent the user from reaching /inbox.
          _bootSyncEngines();
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

        // WhatsApp-grade refusal: even if checkAuth came back rejected,
        // if the token has been confirmed alive in the last 90 days,
        // treat it as a transient edge glitch (Redis blip, opcache miss,
        // sliding-renewal write skew) and hydrate from offline cache.
        // The next API roundtrip will either succeed (proving the
        // rejection was bogus) or trigger the 100-strike counter, which
        // ALSO consults the 90-day grace and refuses to logout. Only
        // a *truly* aged-out token actually kicks the user.
        if (serverRejectedAuth && api.isTokenWithinGracePeriod?.()) {
          try { api.recordLogoutAttempt?.('refused_within_grace', { source: 'checkauth_cold_start' }); } catch {}
          console.warn('[auth] checkAuth rejected on cold start but token <90d old — keeping session');
          if (await hydrateOffline()) return;
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
          try { api.recordLogoutAttempt?.('cold_start_server_rejected', { source: 'web_boot' }); } catch {}
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
      // ensurePushTokenFresh handles register + sendTokenToBackend, plus
      // tracks consecutive failures and sets the global banner flag when
      // the token registration silently breaks (incident 2026-05-18). We
      // already throttle the outer call to once per 5min via the AppState
      // hook, so pass force:true to bypass the helper's own 6h throttle —
      // otherwise the AuthContext schedule would be a no-op after the
      // first call of each 6h window.
      const { ensurePushTokenFresh } = await import('../services/pushNotifications');
      await ensurePushTokenFresh({ force: true });
      // Mirror for iOS VoIP push token. Android piggybacks the FCM device
      // token via ensurePushTokenFresh above, so this is iOS-only.
      if (Platform.OS === 'ios') {
        try {
          const { ensureVoipTokenFresh } = await import('../services/callkeep');
          await ensureVoipTokenFresh({ force: true });
        } catch {}
      }
    } catch {}
  }, []);

  // Re-register push token EVERY time the app comes to foreground (throttled
  // to once per 5min). Reason: Android fcm_device token can be missing if the
  // initial registration ran before FCM SDK was warm (cold start race). Also
  // tokens periodically rotate. Without re-registration, the user stops
  // getting pushes silently. Suggested by user (2026-05-12): "tem que ser
  // toda ves que a pessoa loga, faz mais sentido".
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let lastReg = 0;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const now = Date.now();
      if (now - lastReg < 5 * 60 * 1000) return; // throttle 5min
      if (!user?.email) return; // only when logged in
      lastReg = now;
      registerPushAfterAuth();
    });
    return () => sub?.remove?.();
  }, [user?.email, registerPushAfterAuth]);

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
    // Capture the previously-active email BEFORE api.login mutates it, so
    // we can detect an account switch (or first login on a device that
    // previously had another user signed in) and surgically purge the
    // three bare-key MMKV blobs + the legacy unscoped localStorage twin
    // that don't include the user identity in their key and therefore
    // leak across accounts.
    const _prevEmail = (api.getActiveAccountEmail?.() || '').toLowerCase();
    const r = await api.login(email, password);
    if (r.success && !r.data?.requires_verification) {
      // Re-arm the auto-logout guard so a future token expiry on THIS
      // session routes to /login again (flag is once-per-process).
      try { api.resetAuthFailureSignal?.(); } catch {}
      const _newEmail = (r.data?.email || email || '').toLowerCase();
      const _isSwitch = !!_prevEmail && _prevEmail !== _newEmail;
      if (!_prevEmail || _prevEmail !== _newEmail) {
        await clearAccountScopedMmkv();
      }
      // Account swap: gate any sync getter for the next 500ms. We used to
      // also drop user to null here so chat screens unmounted before the new
      // email landed, but the dual-fire `setUser(null); ...await...;
      // setUser(r.data)` was kicking MailContext's WS effect twice and
      // feeding the reconnect storm (root cause 3, 2026-05-19). The cache
      // scope lock + setCacheUser(null) below keep the sync getters from
      // serving stale data; the brief paint flash is acceptable in exchange
      // for stable WS lifecycle.
      if (_isSwitch) {
        _lockCacheScopeSync(500);
        setCacheUser(null);
      }
      await clearAllCache();
      const clearChatCache = await getLazyClearChatCache(); await clearChatCache();
      setCacheUser(r.data?.email || email);
      setUser(r.data);
      try {
        const { setReporterIdentity, reportStep } = require('../services/crashReporter');
        const tok = (r.data?.token || api.getAuthToken?.() || '').toString();
        setReporterIdentity({ email: r.data?.email || email, bearer: tok });
        reportStep('login_setUser_ok', `email=${r.data?.email || email}`);
      } catch {}
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
      // [#1175 2026-05-18] AWAIT persistAuthForNativeCall (no fire-and-
      // forget) so the next call_invite — which can arrive within seconds
      // of login (push from peer who saw us come online) — has a populated
      // SharedPreferences entry for LkTokenFetcher to mint a LiveKit
      // token. Previously this was called fire-and-forget via
      // setAuthTokenDirect, which made the SharedPreferences write race
      // against the first incoming call. Bounded to 600ms so an outage of
      // the bridge never stalls login.
      try {
        if (Platform.OS !== 'web') {
          const tok = (r.data?.token || api.getAuthToken?.() || '').toString();
          const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
          if (tok) {
            const mod = require('../modules/expo-callkit');
            const persist = mod?.persistAuthForNativeCall;
            if (typeof persist === 'function') {
              await Promise.race([
                Promise.resolve(persist(tok, baseUrl)).catch(() => {}),
                new Promise((r) => setTimeout(r, 600)),
              ]);
            }
          }
        }
      } catch {}
      // Initial sync — download everything to SQLite (WhatsApp-style).
      // Boots deltaSync (1min interval + AppState refresh) and the foreground
      // envelopePuller (30s pull when active, gated on
      // globalThis.__chatyy_envelope_mode). Both idempotent.
      _bootSyncEngines();
      // Set child status from login response
      if (r.data?.is_child) {
        _childRestrictions = r.data.child_restrictions || {};
      } else {
        _childRestrictions = null;
      }
      // First-launch cloud-restore prompt — fires once per device. Runs
      // fire-and-forget so the login flow returns immediately; the chat
      // list listens to subscribeRestorePrompt() and renders the modal.
      _maybeOfferCloudRestore().catch(() => {});
      // What's-New tour — same fire-and-forget pattern. Only fires for
      // upgraded users (last-seen-version differs from CURRENT_VERSION);
      // cold installs simply bookmark the version and skip.
      _maybeOfferWhatsNew().catch(() => {});
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth, prefetchAvatar, prefetchProfile]);

  const completeLoginAfterChallenge = useCallback(async (data) => {
    // Snapshot the prev email BEFORE we mutate auth state so we can detect
    // an account switch and run the surgical bare-key cleaner.
    const _prevEmail = (api.getActiveAccountEmail?.() || '').toLowerCase();
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
    const _newEmail = (data?.email || '').toLowerCase();
    const _isSwitch = !!_prevEmail && _prevEmail !== _newEmail;
    if (!_prevEmail || _prevEmail !== _newEmail) {
      await clearAccountScopedMmkv();
    }
    // Same paint-race fence as login() — see lockCacheScope. setUser(null)
    // removed (root cause 3 of reconnect storm fix 2026-05-19): the dual
    // fire was kicking MailContext's WS effect twice.
    if (_isSwitch) {
      _lockCacheScopeSync(500);
      setCacheUser(null);
    }
    await clearAllCache();
    const _clearChat = await getLazyClearChatCache(); await _clearChat();
    setCacheUser(data?.email);
    setUser(data);
    loadAccounts();
    registerPushAfterAuth();
    _bootSyncEngines();
    // [#1175 2026-05-18] AWAIT persistAuthForNativeCall — see login() above.
    try {
      if (Platform.OS !== 'web') {
        const tok = (data?.token || api.getAuthToken?.() || '').toString();
        const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
        if (tok) {
          const mod = require('../modules/expo-callkit');
          const persist = mod?.persistAuthForNativeCall;
          if (typeof persist === 'function') {
            await Promise.race([
              Promise.resolve(persist(tok, baseUrl)).catch(() => {}),
              new Promise((r) => setTimeout(r, 600)),
            ]);
          }
        }
      }
    } catch {}
    _maybeOfferCloudRestore().catch(() => {});
    _maybeOfferWhatsNew().catch(() => {});
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
    // Surgically clear the three bare-key MMKV blobs + legacy localStorage
    // twin when the bearer-token login lands on a potentially different
    // identity:
    //   • isAccountSwitch — explicit prev≠new (classic account switch).
    //   • !prevEmail      — no active session (cold start, or right after
    //     logout). Critical for fresh signup: phone_signup → loginWithToken
    //     comes in here with prevEmail='', so without this the new user
    //     would inherit the old user's conversations cache / profile blob.
    // The "preserve cache for Face ID re-login of same user" optimization
    // still applies — that path always has prevEmail set AND prev==new.
    //
    // Replaces the previous aggressive clearAllPerAccountCaches() call
    // which also nuked the SQLite outbox + AsyncStorage `u:*` keys and
    // broke Android send (rollback 2026-05-11).
    const shouldNuke = isAccountSwitch || !prevEmail;
    if (shouldNuke) {
      await clearAccountScopedMmkv();
    }
    setCacheUser(data.email || email);
    setUser(data);
    if (data.is_child) {
      _childRestrictions = data.child_restrictions || {};
    }
    loadAccounts();
    registerPushAfterAuth();
    _bootSyncEngines();
    // [#1175 2026-05-18] AWAIT persistAuthForNativeCall — see login() above.
    try {
      if (Platform.OS !== 'web') {
        const tok = (authToken || api.getAuthToken?.() || '').toString();
        const baseUrl = (api.getBaseUrl?.() || 'https://chatyy.com.br').toString();
        if (tok) {
          const mod = require('../modules/expo-callkit');
          const persist = mod?.persistAuthForNativeCall;
          if (typeof persist === 'function') {
            await Promise.race([
              Promise.resolve(persist(tok, baseUrl)).catch(() => {}),
              new Promise((r) => setTimeout(r, 600)),
            ]);
          }
        }
      }
    } catch {}
    // First-launch cloud-restore — same prompt path as login(). Only fires
    // when chatyy_restored_once is unset, so QR/Face-ID re-logins of the
    // same user on the same device won't re-trigger it.
    _maybeOfferCloudRestore().catch(() => {});
    _maybeOfferWhatsNew().catch(() => {});
    return { success: true, data };
  }, [loadAccounts, registerPushAfterAuth]);

  const signup = useCallback(async (username, password, name, domain) => {
    const r = await api.signup(username, password, name, domain);
    if (r.success) {
      // Defense-in-depth: signup creates a brand new account, so surgically
      // clear the three bare-key MMKV blobs + legacy localStorage twin
      // that don't include user identity and would otherwise bleed the
      // previous user's conversations / profile / call history into the
      // newly-created account. Switched from the aggressive
      // clearAllPerAccountCaches() because that also nuked SQLite outbox
      // + AsyncStorage `u:*` keys and broke Android send (2026-05-11).
      await clearAccountScopedMmkv();
      setCacheUser(r.data?.email);
      setUser(r.data);
      loadAccounts();
      registerPushAfterAuth();
    }
    return r;
  }, [loadAccounts, registerPushAfterAuth]);

  const doLogout = useCallback(async (reason = 'explicit') => {
    // ---- WhatsApp parity: "uma vez logado, não sai mais" ----
    // doLogout() is the ONLY path that calls setUser(null) + clears bearer.
    // It must be triggered EXCLUSIVELY by:
    //   (a) User tapping "Sair" in settings / ChatProfileTab (reason='explicit')
    //   (b) Server explicitly returning `error: logged_out`/`revoked` 401
    //       (reason='explicit_revoke') — sibling device revoke, password
    //       change, admin kick, or current-device logout endpoint.
    //   (c) Account deletion success (reason='explicit')
    //   (d) `remove_account` from multi-account picker (reason='remove_account')
    // It must NEVER be triggered by:
    //   - Transient network errors / offline state
    //   - Streak of 401s without explicit revoke marker
    //   - WS auth_error flapping (already gated in handleAuthFailure)
    //   - App backgrounded / inactivity / token "age"
    // Audit trail — every logout path records its reason so support can
    // post-mortem "why did Carol get kicked out?". WhatsApp-grade: an
    // unexplained logout is a bug we want to see.
    try { await api.recordLogoutAttempt?.(reason, { source: 'doLogout' }); } catch {}
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
    // 3a. SECURITY: explicit logout clears `bio_token` so the next cold
    //     start does NOT silently auto-login via Face ID using a stale
    //     bearer (user reported 2026-05-09: "sai da conta, fechei a página
    //     e voltou logado"). We keep `bio_email` so the login screen still
    //     pre-fills the email field (nice UX), but the secret token is
    //     gone — Face ID prompts the user, then needs a password since
    //     bio_token is missing. Telegram/WhatsApp pattern: explicit
    //     logout = full credential nuke; biometric is opt-in on next login.
    try {
      if (Platform.OS !== 'web') {
        const SecureStore = require('expo-secure-store');
        SecureStore.deleteItemAsync('bio_password').catch(() => {}); // legacy cleanup
        SecureStore.deleteItemAsync('bio_token').catch(() => {});    // SECURITY: kill auto-relogin
      }
    } catch {}
    // 4. Tear down background services so the NEXT account doesn't inherit
    //    WebSocket listeners, MQTT subscriptions, push registrations, or the
    //    edge-detection interval from the previous user.
    try { api.stopEdgeDetection?.(); } catch {}
    // Stop the WA-Web sync engines so the next user that signs in starts
    // a fresh interval/listener pair. _bootSyncEngines() is idempotent so
    // even without this they'd just be reused; tearing down keeps the
    // semantics clean (no leaked AppState listener firing for account A
    // after account B signs in).
    try { _teardownSyncEngines(); } catch {}
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
            // ── Paint-race fence ────────────────────────────────────────
            // 1. Lock cache scope BEFORE any await so sync getters that
            //    might fire during the awaits below already short-circuit.
            // 2. Clear caches (awaited).
            // 3. Setting the new user repaints from the now-empty cache,
            //    which fills via the fresh fetch shortly after.
            // (Previously also did `setUser(null)` between to force chat
            //  screens to unmount, but that dual-fired MailContext's WS
            //  effect — root cause 3 of reconnect storm fix 2026-05-19.
            //  The cache-scope lock + cleared SmartCache below keep stale
            //  data from painting; minor flash is acceptable for stable
            //  WS lifecycle.)
            // [#1223 2026-05-20 Wave 6] Clear chatyy_offline_user FIRST so a
            // hard kill DURING the cache wipe doesn't resurrect the previous
            // account on next cold start via hydrateOffline. Previously this
            // ran AFTER clearAllCache, leaving a window where User A's
            // payload remained in AsyncStorage even though SmartCache was
            // already nuked — could flash User A's data to User B.
            try { await AsyncStorage.removeItem('chatyy_offline_user'); } catch {}
            _lockCacheScopeSync(500);
            setCacheUser(null);
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
      doLogout('remove_account');
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
    const handleAuthFailure = async () => {
      if (Date.now() - _handled < 1500) return; // debounce duplicate fires
      _handled = Date.now();
      // [2026-05-19] WhatsApp parity — explicit-revoke FAST PATH.
      // If api.js signalled because the server explicitly returned
      // `error: logged_out`/`revoked` (user tapped Sair on another device,
      // password changed, admin kicked), we trust it and logout immediately,
      // bypassing the grace/in-call/HTTP-confirm guards below. Those guards
      // exist to protect against TRANSIENT 401s — but an explicit revoke is
      // by definition not transient. Without this fast-path, a logout from a
      // companion device wouldn't propagate (grace window would refuse).
      try {
        if (typeof globalThis !== 'undefined' && globalThis.__chatyy_authFailureReason === 'explicit_revoke') {
          globalThis.__chatyy_authFailureReason = null;
          try { api.recordLogoutAttempt?.('explicit_revoke', { source: 'authcontext_signal' }); } catch {}
          try { api.resetAuthFailureSignal?.(); } catch {}
          console.warn('[auth] Explicit revoke from server — logging out');
          doLogout('explicit_revoke');
          return;
        }
      } catch {}
      // [#1165 2026-05-18] In-call protection: if a call is happening (or
      // recently ended) the WS auth_error storm is a known transient — the
      // native CallSignalWs and the JS WS hold the same bearer and the
      // edge hub can briefly race. Refuse to logout while the marker is
      // live; the post-call cleanup window will also verify via HTTP.
      try {
        if (typeof globalThis !== 'undefined' && globalThis.__chatyyCallActive) {
          api.recordLogoutAttempt?.('refused_during_call', {
            source: 'authcontext_signal',
          });
          api.resetAuthFailureSignal?.();
          // [WAVE 43G 2026-05-21] Revive WS if it tombstoned itself.
          try {
            const ws = require('../services/websocket').default;
            if (ws?.resurrect) ws.resurrect('authcontext_refused_during_call');
          } catch {}
          console.warn('[auth] Auth-failure signal during active call — refusing logout (#1165)');
          return;
        }
      } catch {}
      // WhatsApp-grade refusal: if the token has been confirmed alive in
      // the last 90 days, the 401 signal almost certainly came from an
      // edge hiccup, not a true revocation. Refuse to logout, reset the
      // api-side flag, and let the user keep their session — the next
      // healthy API call will reconverge them.
      try {
        if (api.isTokenWithinGracePeriod?.()) {
          api.recordLogoutAttempt?.('refused_within_grace', {
            source: 'authcontext_signal',
          });
          api.resetAuthFailureSignal?.();
          // [WAVE 43G 2026-05-21] Revive WS if it tombstoned itself. The
          // 90-day grace window is the most common path through this
          // handler — without resurrect, every silent token rejection
          // outside an active call leaves the WS dead. This is the
          // dominant cause of the "logado mas msgs não chegam" report.
          try {
            const ws = require('../services/websocket').default;
            if (ws?.resurrect) ws.resurrect('authcontext_refused_within_grace');
          } catch {}
          console.warn('[auth] Auth-failure signal received but token <90d old — refusing logout');
          return;
        }
      } catch {}
      // [#1165] Last-chance HTTP confirmation. Many WS auth_error streaks
      // are false alarms — the bearer is actually fine, the edge hub just
      // lost state. Do a single HTTP check_auth before tearing down the
      // session. If HTTP comes back 200, treat the WS signal as noise.
      // Bounded by a 4s timeout so a flaky edge can't hold logout hostage.
      try {
        const confirmed = await Promise.race([
          api.checkAuth().then((r) => !!(r && (r.success || r.data))).catch(() => false),
          new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (confirmed === true) {
          api.recordLogoutAttempt?.('refused_http_confirmed', {
            source: 'authcontext_signal',
          });
          api.resetAuthFailureSignal?.();
          // Clear any in-memory WS streak so the next auth_error doesn't
          // immediately re-trigger.
          try {
            const ws = require('../services/websocket').default;
            if (ws) ws._authFailStreak = 0;
            // [WAVE 43G 2026-05-21] HTTP just confirmed the token is alive —
            // if the WS tombstoned itself (destroyed=true) on the way here,
            // resurrect it now. Without this, AuthContext refused logout but
            // the user is still stuck on a dead WS until next foreground.
            if (ws && typeof ws.resurrect === 'function') {
              ws.resurrect('authcontext_http_confirmed');
            }
          } catch {}
          console.warn('[auth] Auth-failure signal but HTTP check_auth=200 — refusing logout (#1165)');
          return;
        }
        // null = timeout (no answer) — don't trust the WS signal alone if
        // the HTTP path was also unreachable. Network is probably broken.
        if (confirmed === null) {
          api.recordLogoutAttempt?.('refused_http_timeout', {
            source: 'authcontext_signal',
          });
          api.resetAuthFailureSignal?.();
          console.warn('[auth] Auth-failure signal but HTTP timed out — refusing logout, will retry');
          return;
        }
      } catch {}
      console.warn('[auth] Token rejected — forcing logout');
      try { api.resetAuthFailureSignal?.(); } catch {}
      try { api.recordLogoutAttempt?.('signal_from_api', { source: 'authcontext_signal' }); } catch {}
      doLogout('signal_from_api');
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
      <CloudRestorePrompt />
    </AuthContext.Provider>
  );
}

// First-launch cloud restore prompt — fullscreen modal overlay rendered
// inside AuthProvider so it sits above whatever screen the user lands on
// after login (typically chat list). Subscribes to the module-level
// _restorePromptState so login() / loginWithToken() / signup() / challenge
// can all trigger it without prop drilling. The flag write happens here on
// either branch so the prompt never re-fires.
function CloudRestorePrompt() {
  const [state, setState] = React.useState(getRestorePromptState());
  const [busy, setBusy] = React.useState(false);
  const [progressMsg, setProgressMsg] = React.useState('');

  React.useEffect(() => {
    return subscribeRestorePrompt(setState);
  }, []);

  if (!state?.visible) return null;

  const onRestore = async () => {
    if (busy) return;
    setBusy(true);
    setProgressMsg('Baixando backup…');
    try {
      let payload = null;
      try {
        const dl = await api.chatBackupDownload?.();
        if (dl?.success) payload = dl.data ?? dl;
      } catch {}
      // Guard: only attempt restore when we actually got a payload AND it
      // has the expected shape. Restoring `null` or an empty object via
      // chatBackupRestore can wipe local state in the worst case.
      const looksRestorable = payload && (Array.isArray(payload?.conversations)
        || Array.isArray(payload?.messages) || typeof payload?.snapshot === 'string');
      if (looksRestorable) {
        setProgressMsg('Restaurando…');
        try { await api.chatBackupRestore?.(payload); } catch {}
      } else {
        setProgressMsg('Backup vazio — abrindo Chatyy do zero');
      }
    } catch {}
    setBusy(false);
    await dismissRestorePrompt();
  };

  const onSkip = async () => {
    if (busy) return;
    await dismissRestorePrompt();
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 360,
            backgroundColor: '#fff',
            borderRadius: 18,
            padding: 24,
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowOffset: { width: 0, height: 8 },
            shadowRadius: 16,
            elevation: 18,
          }}
        >
          <Text style={{ fontSize: 19, fontWeight: '700', color: '#111', textAlign: 'center', marginBottom: 8 }}>
            Restaurar dados do Chatyy?
          </Text>
          <Text style={{ fontSize: 14, color: '#555', textAlign: 'center', lineHeight: 20, marginBottom: 20 }}>
            Encontramos um backup na nuvem. Você pode restaurar suas conversas e mídias agora, ou começar do zero.
          </Text>
          {busy ? (
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <ActivityIndicator size="large" color="#7C3AED" />
              {!!progressMsg && (
                <Text style={{ marginTop: 12, fontSize: 13, color: '#666' }}>{progressMsg}</Text>
              )}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={onSkip}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 12,
                  backgroundColor: 'rgba(0,0,0,0.06)',
                  alignItems: 'center',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#111' }}>Começar do zero</Text>
              </Pressable>
              <Pressable
                onPress={onRestore}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 12,
                  backgroundColor: '#7C3AED',
                  alignItems: 'center',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Restaurar</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
