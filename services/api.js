import { Platform } from 'react-native';

// ─── Edge Network — auto-detect fastest server ───
// Tests all edge servers in parallel, picks the one with lowest latency.
// Remembers the best server in MMKV so next app open is instant.

const EDGE_SERVERS = [
  { url: 'https://chatyy.com.br', region: 'br', base: 'https://chatyy.com.br' },
];

let _bestServer = null;
let _detecting = false;

// Restore last known best server from MMKV (instant, <1ms)
function _restoreCachedServer() {
  try {
    const mmkv = require('./mmkv');
    const cached = mmkv.getString('edge_best_server');
    if (cached) {
      const parsed = JSON.parse(cached);
      // Invalidate cache if edge list changed (version 9 = 5 servers: us, eu, asia, br, eu-direct)
      if (parsed.v !== 9) { mmkv.delete('edge_best_server'); return; }
      const match = EDGE_SERVERS.find(s => s.region === parsed.region);
      if (match) {
        _bestServer = { ...match, latency: parsed.latency };
        API_URL = match.url + '/api/email.php';
        BASE_URL = match.base;
        console.log('[API] Restored edge: ' + match.region + ' (' + parsed.latency + 'ms cached)');
      }
    }
  } catch {}
}
_restoreCachedServer();

async function detectFastestServer() {
  if (_detecting) return;
  _detecting = true;
  try {
    const results = await Promise.allSettled(
      EDGE_SERVERS.map(async (s) => {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          await fetch(s.url + '/health', { signal: controller.signal, cache: 'no-store' });
          clearTimeout(timeout);
          return { ...s, latency: Date.now() - start };
        } catch { clearTimeout(timeout); return { ...s, latency: 99999 }; }
      })
    );
    const sorted = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => a.latency - b.latency);
    if (sorted.length > 0 && sorted[0].latency < 4000) {
      _bestServer = sorted[0];
      API_URL = _bestServer.url + '/api/email.php';
      BASE_URL = _bestServer.base;
      console.log(`[API] Best server: ${_bestServer.region} (${_bestServer.latency}ms)`);
      // Save to MMKV for instant restore on next app open
      try {
        const mmkv = require('./mmkv');
        mmkv.setString('edge_best_server', JSON.stringify({ region: _bestServer.region, latency: _bestServer.latency, v: 9 }));
      } catch {}
    }
  } catch {} finally { _detecting = false; }
}

// Detect immediately (don't wait 2s)
detectFastestServer();

// Re-detect every 5 min in case network changes
setInterval(detectFastestServer, 300000);

// Export for components that need to know the current edge
export function getEdgeInfo() {
  return _bestServer ? { region: _bestServer.region, latency: _bestServer.latency, url: _bestServer.url } : null;
}

// Always returns the current BASE_URL (not a stale captured value from import time)
export function getBaseUrl() {
  return BASE_URL;
}

let API_URL = 'https://chatyy.com.br/api/email.php';
export let BASE_URL = 'https://chatyy.com.br';
const TIMEOUT_MS = 15000;

let sessionCookie = '';
let authToken = '';
let csrfToken = ''; // CSRF protection token from server
let savedCredentials = null; // For auto-relogin on session expiry

// Go Fast Auth endpoints (100x faster than PHP)
function goAuthUrl(path) {
  return (BASE_URL || 'https://chatyy.com.br') + '/api/go-auth/' + path;
}
let deviceTrustToken = ''; // Device trust token — persists across sessions to prevent re-verification

// Token readiness promise — resolves when authToken is loaded from storage
let _tokenReadyResolve = null;
const _tokenReadyPromise = new Promise((resolve) => { _tokenReadyResolve = resolve; });

export function getAuthHeaders() {
  const h = {};
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

// Token & credential persistence — works on BOTH web and mobile
async function getStoredToken() {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('mail_token') : null;
    }
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync('mail_token');
  } catch { return null; }
}

async function storeToken(token) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (token) localStorage.setItem('mail_token', token);
        else localStorage.removeItem('mail_token');
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (token) await SecureStore.setItemAsync('mail_token', token);
    else await SecureStore.deleteItemAsync('mail_token');
  } catch {}
}

function getStoredCredentials() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const c = localStorage.getItem('mail_creds');
      return c ? JSON.parse(c) : null;
    }
  } catch {}
  return null;
}

function storeCredentials(email, password) {
  // Only store in memory — never persist plaintext passwords to localStorage
  // The server session handles persistence; auto-relogin uses in-memory creds only
}

// --- Device trust token storage (persists to survive app restarts) ---
async function getStoredTrustToken() {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('device_trust_token') : null;
    }
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync('device_trust_token');
  } catch { return null; }
}

async function storeTrustToken(token) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (token) localStorage.setItem('device_trust_token', token);
        else localStorage.removeItem('device_trust_token');
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (token) await SecureStore.setItemAsync('device_trust_token', token);
    else await SecureStore.deleteItemAsync('device_trust_token');
  } catch {}
}

// Load trust token on startup
(async () => {
  try {
    const stored = await getStoredTrustToken();
    if (stored) deviceTrustToken = stored;
  } catch {}
})();

// --- Multi-account storage (works on web + mobile) ---
let _cachedAccounts = null;

function getStoredAccounts() {
  if (_cachedAccounts) return _cachedAccounts;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const a = localStorage.getItem('mail_accounts');
      _cachedAccounts = a ? JSON.parse(a) : [];
      return _cachedAccounts;
    }
  } catch {}
  return _cachedAccounts || [];
}

function storeAccounts(accounts) {
  _cachedAccounts = accounts;
  try {
    const json = JSON.stringify(accounts);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem('mail_accounts', json);
    } else {
      const SecureStore = require('expo-secure-store');
      SecureStore.setItemAsync('mail_accounts', json).catch(() => {});
    }
  } catch {}
}

// Load accounts from SecureStore on mobile at startup
(async () => {
  if (Platform.OS !== 'web') {
    try {
      const SecureStore = require('expo-secure-store');
      const a = await SecureStore.getItemAsync('mail_accounts');
      if (a) _cachedAccounts = JSON.parse(a);
    } catch {}
  }
})();

let _cachedActiveAccount = '';

function getActiveAccountEmail() {
  if (_cachedActiveAccount) return _cachedActiveAccount;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      _cachedActiveAccount = localStorage.getItem('mail_active_account') || '';
    }
  } catch {}
  return _cachedActiveAccount;
}

function setActiveAccountEmail(email) {
  _cachedActiveAccount = email || '';
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      if (email) localStorage.setItem('mail_active_account', email);
      else localStorage.removeItem('mail_active_account');
    } else {
      const SecureStore = require('expo-secure-store');
      if (email) SecureStore.setItemAsync('mail_active_account', email).catch(() => {});
      else SecureStore.deleteItemAsync('mail_active_account').catch(() => {});
    }
  } catch {}
}

// Load active account from SecureStore on mobile at startup
(async () => {
  if (Platform.OS !== 'web') {
    try {
      const SecureStore = require('expo-secure-store');
      const a = await SecureStore.getItemAsync('mail_active_account');
      if (a) _cachedActiveAccount = a;
    } catch {}
  }
})();

// Add or update account in stored accounts list (never store passwords)
function upsertAccount(email, password, name) {
  const accounts = getStoredAccounts();
  const idx = accounts.findIndex(a => a.email === email);
  // Store token for account switching (NOT plaintext password)
  const token = authToken || '';
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], email, name: name || accounts[idx].name, token };
  } else {
    accounts.push({ email, name: name || '', token });
  }
  storeAccounts(accounts);
}

export { getStoredAccounts, storeAccounts, getActiveAccountEmail, setActiveAccountEmail, upsertAccount };

function removeStoredAccount(email) {
  const accounts = getStoredAccounts().filter(a => a.email !== email);
  storeAccounts(accounts);
  if (getActiveAccountEmail() === email) setActiveAccountEmail('');
}

export { removeStoredAccount };

export function getToken() { return authToken; }

// Initialize token from storage SYNCHRONOUSLY on web to prevent race conditions
// (checkAuth may fire before async init completes, causing false logout)
if (Platform.OS === 'web') {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('mail_token');
      if (stored) authToken = stored;
      localStorage.removeItem('mail_creds');
      const accts = getStoredAccounts();
      if (accts.some(a => a.password)) {
        storeAccounts(accts.map(({ password, ...rest }) => rest));
      }
    }
  } catch {}
  _tokenReadyResolve();
} else {
  // Native: async init is ok since SecureStore requires await
  (async () => {
    try {
      const stored = await getStoredToken();
      if (stored) authToken = stored;
    } finally {
      _tokenReadyResolve();
    }
  })();
}

let _reloginPromise = null;

async function _rawApiCall(action, params = {}, method = 'GET') {
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (method === 'POST' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (deviceTrustToken) headers['X-Device-Trust-Token'] = deviceTrustToken;

  let url = `${API_URL}?action=${action}`;
  const options = { method, headers, credentials: 'include' };

  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url += `&${k}=${encodeURIComponent(v)}`;
    });
  } else {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ action, ...params });
  }

  const controller = new AbortController();
  options.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, options);
    clearTimeout(timeout);

    const cookie = res.headers.get('set-cookie');
    if (cookie) sessionCookie = cookie.split(';')[0];

    const newToken = res.headers.get('x-auth-token');
    if (newToken) {
      authToken = newToken;
      storeToken(newToken);
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const respToken = data?.data?.token;
      if (respToken && respToken !== authToken) {
        authToken = respToken;
        storeToken(respToken);
      }
      // Store CSRF token from login/check_auth responses
      const respCsrf = data?.data?.csrf_token;
      if (respCsrf) csrfToken = respCsrf;
      return { data, status: res.status };
    } catch {
      return { data: { success: false, message: 'Servidor indisponivel' }, status: res.status };
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: { success: false, message: 'Tempo limite excedido' }, status: 0 };
    }
    return { data: { success: false, message: 'Connection error' }, status: 0 };
  }
}

export async function apiCall(action, params = {}, method = 'GET') {
  const result = await _rawApiCall(action, params, method);

  // Auto-relogin: if server returns 401 and we have in-memory credentials, try to re-authenticate
  // BUT don't block - if relogin takes too long, return the 401 result
  if (result.status === 401 && action !== 'login' && action !== 'check_auth') {
    const creds = savedCredentials;
    if (creds?.email && creds?.password) {
      if (!_reloginPromise) {
        const reloginTimeout = new Promise(r => setTimeout(() => r({ data: { success: false } }), 15000));
        _reloginPromise = Promise.race([
          _rawApiCall('login', { email: creds.email, password: creds.password }, 'POST').catch(() => ({ data: { success: false } })),
          reloginTimeout,
        ]).finally(() => { _reloginPromise = null; });
      }
      const loginResult = await _reloginPromise;
      if (loginResult.data?.success) {
        await new Promise(r => setTimeout(r, 2000)); // Wait for PG replication
        const retry = await _rawApiCall(action, params, method);
        return retry.data;
      }
    }
  }

  return result.data;
}

export async function login(email, password) {
  // Go Fast Auth for token (< 50ms) + PHP login in background for full session
  let r;
  try {
    const [goRes, phpRes] = await Promise.all([
      fetch(goAuthUrl('login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then(res => res.json()).catch(() => null),
      apiCall('login', { email, password }, 'POST').catch(() => null),
    ]);
    // Use Go response (faster) but PHP runs in parallel to create full session
    r = goRes?.success ? goRes : (phpRes || { success: false, message: 'Login failed' });
  } catch {
    r = await apiCall('login', { email, password }, 'POST');
  }
  if (r.success) {
    // Save credentials for auto-relogin when session expires
    savedCredentials = { email, password };
    storeCredentials(email, password);
    const token = r?.data?.token || r?.token;
    if (token) {
      authToken = token;
      await storeToken(token);
    }
    // Save device trust token (prevents re-verification on same device)
    const trustTk = r?.data?.device_trust_token;
    if (trustTk) {
      deviceTrustToken = trustTk;
      storeTrustToken(trustTk);
    }
    // Multi-account: store this account
    const name = r.data?.name || r.data?.email || email;
    upsertAccount(email, password, name);
    setActiveAccountEmail(email);

    // Cache login response data for instant screen loads
    try {
      const { setString, setJSON } = require('./mmkv');
      if (r.data?.conversations?.length) {
        // Cache for chatCache.js (getCachedConversations reads 'chat_conversations')
        setString('chat_conversations', JSON.stringify(r.data.conversations));
      }
      if (r.data?.profile) setJSON('omc_profile', { data: r.data.profile, ts: Date.now() });
      if (r.data?.call_history) setJSON('omc_call_history', { data: r.data.call_history, ts: Date.now() });
      if (r.data?.folders) {
        // Cache for offlineCache.js (getEmailsFromCache reads 'omc_list_INBOX')
        const { setCache } = require('./cache');
        setCache('email_folders', r.data.folders, 600000).catch(() => {});
      }
    } catch {}
  }
  return r;
}

export async function signup(username, password, name, domain = 'chatyy.com.br', extra = {}) {
  const r = await apiCall('signup', { username, password, name, domain, ...extra }, 'POST');
  if (r.success) {
    const email = `${username}@${domain}`;
    savedCredentials = { email, password };
    storeCredentials(email, password);
    const token = r?.data?.token || r?.token;
    if (token) {
      authToken = token;
      await storeToken(token);
    }
  }
  return r;
}

export async function checkUsername(username, domain = 'chatyy.com.br') {
  return apiCall('check_username', { username, domain });
}

// --- Login Challenge (new device verification) ---
export async function checkLoginChallenge(challengeId, email) {
  return apiCall('check_login_challenge', { challenge_id: challengeId, email }, 'POST');
}

export async function verifyLoginChallenge(challengeId, action) {
  return apiCall('verify_login_challenge', { challenge_id: challengeId, action }, 'POST');
}

export async function logout() {
  const r = await apiCall('logout', {}, 'POST');
  sessionCookie = '';
  authToken = '';
  csrfToken = '';
  savedCredentials = null;
  await storeToken(null);
  return r;
}

export async function checkAuth() {
  return apiCall('check_auth');
}

export async function getInbox(folder = 'INBOX', page = 1, perPage = 20, search = '', category = '', label = '') {
  const params = { folder, page, per_page: perPage, search };
  if (category && category !== 'all') params.category = category;
  if (label) params.label = label;
  return apiCall('inbox', params);
}

export async function getMessage(uid, folder = 'INBOX') {
  return apiCall('message', { uid, folder });
}

export async function getFolders() {
  return apiCall('folders');
}

export async function sendEmail(to, subject, body, cc = '', bcc = '', replyToUid = null, folder = 'INBOX', attachments = []) {
  // If attachments provided, use FormData instead of JSON
  if (attachments && attachments.length > 0) {
    const formData = new FormData();
    formData.append('action', 'send');
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('body', body);
    if (cc) formData.append('cc', cc);
    if (bcc) formData.append('bcc', bcc);
    if (replyToUid) formData.append('reply_to_uid', replyToUid);
    if (folder) formData.append('folder', folder);
    formData.append('undo_delay', '0');
    attachments.forEach((att, i) => {
      if (att._raw) {
        formData.append(`attachment_${i}`, att._raw, att.name);
      } else if (att.uri) {
        formData.append(`attachment_${i}`, { uri: att.uri, type: att.type || 'application/octet-stream', name: att.name });
      }
    });

    const headers = {};
    if (sessionCookie) headers['Cookie'] = sessionCookie;
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    // Do NOT set Content-Type — browser/RN will set multipart boundary automatically

    const controller = new AbortController();
    const uploadTimeout = 120000; // 2 min for attachments
    const timeout = setTimeout(() => controller.abort(), uploadTimeout);

    try {
      const res = await fetch(`${API_URL}?action=send`, {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, message: 'Servidor indisponivel' };
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return { success: false, message: 'Tempo limite excedido' };
      }
      return { success: false, message: 'Connection error' };
    }
  }

  return apiCall('send', { to, subject, body, cc, bcc, reply_to_uid: replyToUid, folder, undo_delay: 0 }, 'POST');
}

export async function deleteEmail(uid, folder = 'INBOX') {
  return apiCall('delete', { uid, folder }, 'POST');
}

export async function markRead(uid, folder = 'INBOX') {
  // Use keepalive fetch so the request completes even if the user closes the tab
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      const res = await fetch(`${API_URL}?action=mark_read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'mark_read', uid, folder }),
        credentials: 'include',
        keepalive: true,
      });
      const data = await res.json();
      return data;
    } catch {
      return apiCall('mark_read', { uid, folder }, 'POST');
    }
  }
  return apiCall('mark_read', { uid, folder }, 'POST');
}

export async function markUnread(uid, folder = 'INBOX') {
  return apiCall('mark_unread', { uid, folder }, 'POST');
}

export async function moveEmail(uid, toFolder, fromFolder = 'INBOX') {
  return apiCall('move', { uid, folder: fromFolder, to_folder: toFolder }, 'POST');
}

export async function verifySend(phone, channel = 'sms') {
  return apiCall('verify_send', { phone, channel }, 'POST');
}

export async function verifyCheck(phone, code) {
  return apiCall('verify_check', { phone, code }, 'POST');
}

// Star / Unstar
export async function starEmail(uid, folder = 'INBOX') {
  return apiCall('star', { uid, folder }, 'POST');
}

export async function unstarEmail(uid, folder = 'INBOX') {
  return apiCall('unstar', { uid, folder }, 'POST');
}

// Archive
export async function archiveEmail(uid, folder = 'INBOX') {
  return apiCall('move', { uid, folder, to_folder: 'Archive' }, 'POST');
}

// Bulk operations
export async function bulkMarkRead(uids, folder = 'INBOX') {
  return apiCall('bulk_mark_read', { uids, folder }, 'POST');
}

export async function bulkMarkUnread(uids, folder = 'INBOX') {
  return apiCall('bulk_mark_unread', { uids, folder }, 'POST');
}

export async function bulkDelete(uids, folder = 'INBOX') {
  return apiCall('bulk_delete', { uids, folder }, 'POST');
}

export async function bulkArchive(uids, folder = 'INBOX') {
  return apiCall('bulk_archive', { uids, folder }, 'POST');
}

// Snooze
export async function snoozeEmail(uid, snoozeUntil, folder = 'INBOX') {
  return apiCall('snooze', { uid, snooze_until: snoozeUntil, folder }, 'POST');
}

// Labels
export async function addLabel(uid, label, folder = 'INBOX') {
  return apiCall('add_label', { uid, label, folder }, 'POST');
}

export async function removeLabel(uid, label, folder = 'INBOX') {
  return apiCall('remove_label', { uid, label, folder }, 'POST');
}

export async function getLabels() {
  return apiCall('get_labels');
}

// AI
export async function aiAssist(type, context = {}) {
  return apiCall('ai_assist', { type, context }, 'POST');
}

// Profile
export async function getProfile() {
  return apiCall('get_profile');
}

export async function updateProfile(data) {
  return apiCall('update_profile', data, 'POST');
}

// Settings
export async function getSettings() {
  return apiCall('get_settings');
}

export async function updateSettings(data) {
  return apiCall('update_settings', data, 'POST');
}

// Spam / Ham reporting
export async function reportSpam(uid, folder = 'INBOX') {
  return apiCall('report_spam', { uid, folder }, 'POST');
}

export async function reportHam(uid, folder = 'INBOX') {
  return apiCall('report_ham', { uid, folder }, 'POST');
}

// Contacts autocomplete
export async function searchContacts(query) {
  return apiCall('contacts', { q: query });
}

// Find Chatyy user by phone number (returns email + name)
export async function findByPhone(phone) {
  return apiCall('find_by_phone', { phone }, 'POST');
}

// Chatyy user directory - list all registered users
export async function chatyyUsers(query = '', limit = 50, offset = 0) {
  const params = { limit, offset };
  if (query) params.q = query;
  return apiCall('chatyy_users', params);
}

// Send invite email
export async function sendInvite(email, name = '') {
  return apiCall('send_invite', { email, name }, 'POST');
}

// Drafts
export async function saveDraft(data) {
  return apiCall('draft_save', data, 'POST');
}

export async function listDrafts() {
  return apiCall('draft_list');
}

export async function deleteDraft(uid) {
  return apiCall('draft_delete', { uid }, 'POST');
}

// Templates
export async function listTemplates() {
  return apiCall('template_list');
}

export async function saveTemplate(data) {
  return apiCall('template_save', data, 'POST');
}

export async function deleteTemplate(id) {
  return apiCall('template_delete', { id }, 'POST');
}

// Scheduled send
export async function scheduleSend(data) {
  return apiCall('schedule_send', data, 'POST');
}

// Folder management
export async function createFolder(name) {
  return apiCall('create_folder', { name }, 'POST');
}

export async function renameFolder(oldName, newName) {
  return apiCall('rename_folder', { old_name: oldName, new_name: newName }, 'POST');
}

export async function deleteFolder(name) {
  return apiCall('delete_folder', { name }, 'POST');
}

export async function emptyTrash() {
  return apiCall('empty_trash', {}, 'POST');
}

export async function emptySpam() {
  return apiCall('empty_spam', {}, 'POST');
}

// Thread view
export async function getThread(uid, folder = 'INBOX') {
  return apiCall('get_thread', { uid, folder });
}

// Attachment download URL
// TODO: Security concern — bearer token is embedded in URL (visible in browser history, server logs, Referer headers).
// Consider implementing a short-lived download token endpoint on the backend to minimize exposure.
export function getAttachmentUrl(uid, folder, part) {
  return `${API_URL}?action=attachment_download&uid=${uid}&folder=${encodeURIComponent(folder)}&part=${part}&token=${authToken || ''}`;
}

// ---- Forgot Password ----
export async function forgotPasswordOptions(email) {
  return apiCall('forgot_password_options', { email }, 'POST');
}

export async function forgotPasswordInitiate(email, method = 'email') {
  return apiCall('forgot_password_initiate', { email, method }, 'POST');
}

export async function forgotPasswordVerify(email, code) {
  return apiCall('forgot_password_verify', { email, code }, 'POST');
}

export async function resetPassword(email, resetToken, newPassword) {
  return apiCall('reset_password', { email, reset_token: resetToken, new_password: newPassword }, 'POST');
}

// Change password
export async function changePassword(currentPassword, newPassword) {
  return apiCall('change_password', { current_password: currentPassword, new_password: newPassword }, 'POST');
}

// Custom labels
export async function createLabel(name, color) {
  return apiCall('create_label', { name, color }, 'POST');
}

export async function deleteLabel(name) {
  return apiCall('delete_label', { name }, 'POST');
}

// Contacts management
export async function getContactsList() {
  return apiCall('contacts_list');
}

export async function saveContact(data) {
  return apiCall('contact_save', data, 'POST');
}

export async function deleteContact(email) {
  return apiCall('contact_delete', { email }, 'POST');
}

export async function discoverContacts() {
  return apiCall('contacts_discover');
}

export async function listOneMundoUsers() {
  return apiCall('list_onemundo_users');
}

export async function searchOneMundoUsers(query) {
  return apiCall('search_onemundo_users', { query });
}

// Avatar
export async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('action', 'upload_avatar');
  if (file._raw) {
    formData.append('avatar', file._raw, file.name);
  } else if (file.uri) {
    formData.append('avatar', { uri: file.uri, type: file.type || 'image/jpeg', name: file.name || 'avatar.jpg' });
  }
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_URL}?action=upload_avatar`, { method: 'POST', headers, body: formData, credentials: 'include', signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, message: 'Servidor indisponivel' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Tempo limite excedido' };
    return { success: false, message: 'Connection error' };
  }
}

export function getAvatarUrl(email) {
  const e = email || savedCredentials?.email || '';
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(e)}`;
}

export function getAvatarUrlForEmail(email) {
  if (!email) return null;
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(email)}`;
}

/**
 * Convert email username to readable display name.
 * e.g. "anacarla.pereiraramos@x.com" → "Ana Carla Pereira Ramos"
 *      "joao.marcelo@x.com" → "Joao Marcelo"
 *      "Already A Name" → "Already A Name" (unchanged)
 */
const _commonNames = new Set([
  // First names
  'ana','bia','bea','carlos','carla','carolina','clara','daniel','daniela',
  'eduardo','fernanda','fernando','flavia','gabriel','gabriela','guilherme',
  'gustavo','helena','henrique','igor','isabela','jessica','joao','jose',
  'julia','juliana','larissa','leticia','luana','lucas','luiz','luiza',
  'marcelo','marcos','maria','mariana','matheus','mateus','miguel','nathalia',
  'natalia','nicolas','patricia','paula','paulo','pedro','rafael','raquel',
  'renata','renato','ricardo','roberta','roberto','rodrigo','rosa','sandra',
  'sara','sergio','silvia','thiago','tiago','vanessa','vinicius','vitoria',
  'victor','victoria','wallace','walfredo','wesley','william','agata','kerolly',
  'jamily','nicoly','felipe','beatriz','rene','mauricio','leticya','alice',
  'amanda','bruna','bruno','camila','celia','cristina','diego','elisa',
  'fabio','fabiana','giovanna','heloisa','isabelle','jorge','karen','leonardo',
  'livia','lorena','lara','manuela','marina','melissa','nadia','otavio',
  'priscila','rebeca','simone','tatiana','valentina','yasmin',
  // Common surnames (for splitting compound surnames)
  'almeida','alves','araujo','barbosa','barros','batista','borges','braga',
  'campos','cardoso','carvalho','castro','correia','costa','cruz','cunha',
  'dias','duarte','farias','ferreira','fonseca','freitas','garcia','gomes',
  'lima','lopes','machado','martins','medeiros','melo','mendes','miranda',
  'monteiro','moreira','moura','nascimento','neves','nogueira','noronha',
  'nunes','oliveira','pereira','pinto','ramos','reis','ribeiro','rocha',
  'rodrigues','rosa','santos','silva','souza','sousa','teixeira','vieira',
]);

function _splitCompoundName(part) {
  const lower = part.toLowerCase();
  // If the whole part is a known name, return it as-is
  if (_commonNames.has(lower)) return [part];
  if (part.length <= 5) return [part];
  // Try longest prefix first (prefer "beatriz" over "bea")
  for (let len = Math.min(lower.length - 2, 9); len >= 3; len--) {
    const prefix = lower.substring(0, len);
    const rest = lower.substring(len);
    if (_commonNames.has(prefix) && rest.length >= 2) {
      return [prefix, ..._splitCompoundName(rest)];
    }
  }
  return [part];
}

export function emailToDisplayName(nameOrEmail) {
  if (!nameOrEmail) return '';
  let str = nameOrEmail;
  // If it already has spaces and looks like a proper name, return as-is
  if (str.includes(' ') && !str.includes('@')) return str;
  if (str.includes('@')) str = str.split('@')[0];
  // Split by dots, underscores, dashes
  const parts = str.split(/[._-]/);
  const expanded = parts.flatMap(p => _splitCompoundName(p));
  return expanded
    .filter(p => p && typeof p === "string" && p.length > 0).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

// Block / Mute
export async function blockSender(email) {
  return apiCall('block_sender', { email }, 'POST');
}

export async function unblockSender(email) {
  return apiCall('unblock_sender', { email }, 'POST');
}

export async function muteThread(uid, folder = 'INBOX') {
  return apiCall('mute_thread', { uid, folder }, 'POST');
}

export async function unmuteThread(uid, folder = 'INBOX') {
  return apiCall('unmute_thread', { uid, folder }, 'POST');
}

// Export email as EML
// TODO: Security concern — bearer token embedded in URL (see getAttachmentUrl comment)
export function getExportUrl(uid, folder) {
  return `${API_URL}?action=export_email&uid=${uid}&folder=${encodeURIComponent(folder)}&token=${authToken || ''}`;
}

// Active sessions
export async function getSessionsList() {
  return apiCall('sessions_list');
}

export async function revokeSession(tokenHash) {
  return apiCall('revoke_session', { token_hash: tokenHash }, 'POST');
}

export async function revokeAllSessions() {
  return apiCall('revoke_all_sessions', {}, 'POST');
}

// Delete account (Apple requirement)
export async function deleteAccount(password) {
  return apiCall('delete_account', { password }, 'POST');
}

// Token accessor for WebSocket auth
export function getAuthToken() {
  return authToken || null;
}

export function setAuthTokenDirect(token) {
  authToken = token;
  storeToken(token);
}

export function saveTrustToken(token) {
  if (token) {
    deviceTrustToken = token;
    storeTrustToken(token);
  }
}

// ============================================================
// MEETINGS API
// ============================================================
export async function meetCreate(title = 'Meeting', lobbyEnabled = false) {
  return apiCall('meet_create', { title, lobby_enabled: lobbyEnabled }, 'POST');
}

export async function meetSchedule({ title, description, scheduled_at, duration_minutes, lobby_enabled, invitees, recurrence, password }) {
  return apiCall('meet_schedule', { title, description, scheduled_at, duration_minutes, lobby_enabled, invitees, recurrence, password }, 'POST');
}

export async function meetUpdate(roomId, updates) {
  return apiCall('meet_update', { room_id: roomId, ...updates }, 'POST');
}

export async function meetCancel(roomId) {
  return apiCall('meet_cancel', { room_id: roomId }, 'POST');
}

export async function meetDelete(roomId) {
  return apiCall('meet_delete', { room_id: roomId }, 'POST');
}

export async function meetJoin(roomId, password = null) {
  const params = { room_id: roomId };
  if (password) params.password = password;
  return apiCall('meet_join', params, 'POST');
}

export async function meetLeave(roomId) {
  return apiCall('meet_leave', { room_id: roomId }, 'POST');
}

export async function meetEnd(roomId) {
  return apiCall('meet_end', { room_id: roomId }, 'POST');
}

export async function meetInfo(roomId) {
  return apiCall('meet_info', { room_id: roomId });
}

export async function meetList(filter = 'upcoming', limit = 50, offset = 0) {
  return apiCall('meet_list', { filter, limit, offset });
}

export async function meetRsvp(roomId, status) {
  return apiCall('meet_rsvp', { room_id: roomId, status }, 'POST');
}

export async function meetKick(roomId, targetEmail) {
  return apiCall('meet_kick', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetMuteAll(roomId) {
  return apiCall('meet_mute_all', { room_id: roomId }, 'POST');
}

export async function meetLock(roomId) {
  return apiCall('meet_lock', { room_id: roomId }, 'POST');
}

export async function meetUnlock(roomId) {
  return apiCall('meet_unlock', { room_id: roomId }, 'POST');
}

export async function meetLobbyAdmit(roomId, targetEmail) {
  return apiCall('meet_lobby_admit', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetLobbyDeny(roomId, targetEmail) {
  return apiCall('meet_lobby_deny', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetChatHistory(roomId, limit = 200) {
  return apiCall('meet_chat_history', { room_id: roomId, limit });
}

export async function meetRecap(roomId) {
  return apiCall('meet_recap', { room_id: roomId });
}

export async function meetAiSummary(roomId) {
  return apiCall('meet_ai_summary', { room_id: roomId }, 'POST');
}

export async function meetStartRecording(roomId) {
  return apiCall('meet_start_recording', { room_id: roomId }, 'POST');
}

export async function meetStopRecording(roomId) {
  return apiCall('meet_stop_recording', { room_id: roomId }, 'POST');
}

export async function meetPromote(roomId, targetEmail) {
  return apiCall('meet_promote', { room_id: roomId, email: targetEmail }, 'POST');
}

export async function meetDemote(roomId, targetEmail) {
  return apiCall('meet_demote', { room_id: roomId, email: targetEmail }, 'POST');
}

// ============================================================
// CHAT API
// ============================================================
export async function chatConversations(search = '', includeArchived = false) {
  // Go Fast Auth for chat list (< 70ms vs 5-10s PHP)
  if (!search && !includeArchived && authToken) {
    try {
      const goRes = await fetch(goAuthUrl('chat-list'), {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      const goData = await goRes.json();
      if (goData.success) return goData;
    } catch {}
  }
  const params = {};
  if (search) params.search = search;
  if (includeArchived) params.include_archived = 1;
  return apiCall('chat_list', params);
}

export async function chatCreate(members, name = '', type = 'direct') {
  return apiCall('chat_create', { members, name, type }, 'POST');
}

export async function chatMessages(conversationId, limit = 20, beforeId = null, sinceId = 0) {
  const params = { conversation_id: conversationId, limit };
  if (beforeId) params.before_id = beforeId;
  else if (sinceId > 0) params.since_id = sinceId;
  return apiCall('chat_messages', params);
}

export async function chatSend(conversationId, content, type = 'text', replyToId = null, mentions = null, fileUrl = null) {
  // Go Fast Auth for simple text messages (< 50ms)
  if (type === 'text' && !replyToId && !mentions && !fileUrl && authToken) {
    try {
      const goRes = await fetch(goAuthUrl('chat-send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ conversation_id: conversationId, content, type }),
      });
      const goData = await goRes.json();
      if (goData.success) return goData;
    } catch {}
  }
  // Fallback to PHP for complex messages (files, replies, mentions)
  const payload = { conversation_id: conversationId, content, type, reply_to_id: replyToId };
  if (mentions && Array.isArray(mentions) && mentions.length > 0) {
    payload.mentions = JSON.stringify(mentions);
  }
  if (fileUrl) payload.file_url = fileUrl;
  return apiCall('chat_send', payload, 'POST');
}

export async function callNotify(conversationId, callId, video) {
  return apiCall('call_notify', { conversation_id: conversationId, room_id: callId, call_id: callId, video }, 'POST');
}

export async function chatUpdateLiveLocation(messageId, latitude, longitude, address) {
  return apiCall('chat_update_live_location', { message_id: messageId, latitude, longitude, address }, 'POST');
}

export async function chatStopLiveLocation(messageId) {
  return apiCall('chat_stop_live_location', { message_id: messageId }, 'POST');
}

export async function chatEdit(messageId, content) {
  return apiCall('chat_edit', { message_id: messageId, content }, 'POST');
}

export async function chatDelete(messageId, mode = 'for_all') {
  return apiCall('chat_delete_message', { message_id: messageId, mode }, 'POST');
}

export async function chatDeleteBulk(messageIds, mode = 'for_me') {
  return apiCall('chat_delete_message', { message_ids: messageIds, mode }, 'POST');
}

export async function chatReact(messageId, emoji) {
  return apiCall('chat_react', { message_id: messageId, emoji }, 'POST');
}

export async function chatRead(conversationId, messageId) {
  return apiCall('chat_mark_read', { conversation_id: conversationId, message_id: messageId }, 'POST');
}

export async function chatMessageInfo(messageId) {
  return apiCall('chat_message_info', { message_id: messageId });
}

export async function chatMembers(conversationId) {
  return apiCall('chat_info', { conversation_id: conversationId });
}

export async function chatAddMember(conversationId, email) {
  return apiCall('chat_add_member', { conversation_id: conversationId, email }, 'POST');
}

export async function chatLeave(conversationId) {
  return apiCall('chat_leave', { conversation_id: conversationId }, 'POST');
}

export async function chatDeleteConversation(conversationId) {
  return apiCall('chat_delete', { conversation_id: conversationId }, 'POST');
}

export async function chatUpdate(conversationId, updates) {
  return apiCall('chat_update', { conversation_id: conversationId, ...updates }, 'POST');
}

export async function chatSearch(query) {
  return apiCall('chat_search', { query });
}

export async function chatArchive(conversationId, archive = true) {
  return apiCall('chat_archive', { conversation_id: conversationId, archive: archive ? 1 : 0 }, 'POST');
}

export async function chatMute(conversationId, muteUntil = null) {
  return apiCall('chat_mute', { conversation_id: conversationId, mute_until: muteUntil }, 'POST');
}

export async function chatPin(conversationId, messageId) {
  return apiCall('chat_pin', { conversation_id: conversationId, message_id: messageId }, 'POST');
}

export async function chatForward(messageId, targetConversationId) {
  return apiCall('chat_forward', { message_id: messageId, conversation_id: targetConversationId }, 'POST');
}

export async function chatPresence(status = 'online') {
  return apiCall('user_presence', { status }, 'POST');
}

export async function chatTyping(conversationId, recording = false) {
  const params = { conversation_id: conversationId };
  if (recording) params.recording = true;
  return apiCall('chat_typing', params, 'POST');
}

export async function chatStarMessage(messageId, star = true) {
  return apiCall('chat_star_message', { message_id: messageId, star: star ? 1 : 0 }, 'POST');
}

export async function chatStarredMessages() {
  return apiCall('chat_starred_messages', {}, 'POST');
}

// E2E Encryption
export async function e2eUploadKey(publicKey, deviceId = 'default') {
  return apiCall('e2e_upload_key', { public_key: publicKey, device_id: deviceId }, 'POST');
}

export async function e2eGetKeys(emails) {
  return apiCall('e2e_get_keys', { emails }, 'POST');
}

export async function e2eStatus(conversationId) {
  return apiCall('e2e_status', { conversation_id: conversationId });
}

export async function e2eeEnableConversation(conversationId) {
  return apiCall('chat_enable_e2ee', { conversation_id: conversationId }, 'POST');
}

export async function e2eeDisableConversation(conversationId) {
  return apiCall('chat_disable_e2ee', { conversation_id: conversationId }, 'POST');
}

export async function e2eeRegisterKeys(deviceId, identityKey, prekeys) {
  return apiCall('e2ee_register_keys', { device_id: deviceId, identity_key: identityKey, prekeys }, 'POST');
}

export async function e2eeGetKeyBundle(emails) {
  return apiCall('e2ee_get_key_bundle', { emails }, 'POST');
}

export async function e2eePreKeyCount() {
  return apiCall('e2ee_prekey_count', {});
}

// Status (WhatsApp-style stories)
export async function statusPublish(content, type = 'text', bgColor = '#25D366', musicData = null) {
  const params = { content, type, bg_color: bgColor };
  if (musicData) {
    params.music_title = musicData.title || '';
    params.music_artist = musicData.artist || '';
    params.music_preview_url = musicData.previewUrl || '';
    params.music_cover_url = musicData.coverUrl || '';
  }
  return apiCall('status_publish', params, 'POST');
}

export async function statusUpload(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('action', 'status_upload');
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(`${API_URL}?action=status_upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

export async function statusList() {
  return apiCall('status_list');
}

export async function statusView(statusId) {
  return apiCall('status_view', { status_id: statusId }, 'POST');
}

export async function statusDelete(statusId) {
  return apiCall('status_delete', { status_id: statusId }, 'POST');
}

export async function statusViewers(statusId) {
  return apiCall('status_viewers', { status_id: statusId }, 'POST');
}

// Group management
export async function chatLeaveGroup(conversationId) {
  return apiCall('chat_leave_group', { conversation_id: conversationId }, 'POST');
}

export async function chatGroupAdmin(conversationId, targetEmail, action) {
  return apiCall('chat_group_admin', { conversation_id: conversationId, target_email: targetEmail, action }, 'POST');
}

export async function chatRemoveMember(conversationId, targetEmail) {
  return apiCall('chat_remove_member', { conversation_id: conversationId, target_email: targetEmail }, 'POST');
}

export async function chatGroupInfo(conversationId) {
  return apiCall('chat_group_info', { conversation_id: conversationId });
}

export async function chatUpdateGroup(conversationId, updates) {
  return apiCall('chat_update_group', { conversation_id: conversationId, ...updates }, 'POST');
}

export async function chatSetDisappearing(conversationId, timer) {
  return apiCall('chat_set_disappearing', { conversation_id: conversationId, timer }, 'POST');
}

export async function chatLock(conversationId, locked) {
  return apiCall('chat_lock', { conversation_id: conversationId, locked: locked ? 1 : 0 }, 'POST');
}

export async function chatGetLocked() {
  return apiCall('chat_get_locked', {}, 'POST');
}

// Scheduled messages
export async function chatScheduleMessage(conversationId, content, scheduledAt) {
  return apiCall('chat_schedule_message', { conversation_id: conversationId, content, scheduled_at: scheduledAt }, 'POST');
}

export async function chatScheduledList() {
  return apiCall('chat_scheduled_list', {}, 'POST');
}

export async function chatScheduleCancel(scheduledId) {
  return apiCall('chat_schedule_cancel', { scheduled_id: scheduledId }, 'POST');
}

export async function markViewOnce(messageId) {
  return apiCall('mark_view_once', { message_id: messageId }, 'POST');
}

export async function chatSearchGifs(query = '', limit = 20) {
  return apiCall('chat_search_gifs', { query, limit }, 'POST');
}

// Block / Unblock / Report
// Phone OTP login
export async function requestPhoneOtp(phone) {
  return apiCall('request_phone_otp', { phone }, 'POST');
}

export async function verifyPhoneOtp(phone, code) {
  return apiCall('verify_phone_otp', { phone, code }, 'POST');
}

export async function chatBlockUser(email) {
  return apiCall('chat_block_user', { email }, 'POST');
}

export async function chatUnblockUser(email) {
  return apiCall('chat_unblock_user', { email }, 'POST');
}

export async function chatReportUser(email, reason, messageId) {
  const params = { email, reason };
  if (messageId) params.message_id = messageId;
  return apiCall('chat_report_user', params, 'POST');
}

export async function chatBlockedList() {
  return apiCall('chat_blocked_list', {}, 'POST');
}

export async function chatCheckBlocked(email) {
  return apiCall('chat_check_blocked', { email }, 'POST');
}

export async function chatGetSettings() {
  return apiCall('chat_get_settings');
}

export async function chatUpdateSettings(data) {
  return apiCall('chat_update_settings', data, 'POST');
}

export async function chatUploadFile(conversationId, file, content = '', viewOnce = false, onProgress = null) {
  const formData = new FormData();
  formData.append('action', 'chat_upload');
  formData.append('conversation_id', String(conversationId));
  if (content) formData.append('content', content);
  if (viewOnce) formData.append('view_once', '1');
  if (Platform.OS === 'web' && file.blob) {
    // Web: use Blob directly
    formData.append('file', file.blob, file.name || 'file');
  } else {
    formData.append('file', {
      uri: file.uri,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
    });
  }
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  // Use XMLHttpRequest on web for upload progress tracking
  if (Platform.OS === 'web' && onProgress && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}?action=chat_upload`);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.withCredentials = true;
      xhr.timeout = 300000;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(e.loaded / e.total);
        }
      };
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({ success: false, message: 'Upload failed' }); }
      };
      xhr.onerror = () => resolve({ success: false, message: 'Upload failed' });
      xhr.ontimeout = () => resolve({ success: false, message: 'Upload timed out' });
      xhr.send(formData);
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch(`${API_URL}?action=chat_upload`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return { success: false, message: 'Upload failed' };
  }
}

export async function chatUnreadCount() {
  // Use chat_list and sum up unread counts client-side
  const r = await apiCall('chat_list');
  if (r.success && r.data?.conversations) {
    const total = r.data.conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    return { success: true, data: { unread_count: total } };
  }
  return r;
}

export async function chatCreatePoll(conversationId, question, options, multipleChoice = false) {
  return apiCall('chat_create_poll', { conversation_id: conversationId, question, options, multiple_choice: multipleChoice }, 'POST');
}

export async function chatVotePoll(pollId, optionIndex) {
  return apiCall('chat_vote_poll', { poll_id: pollId, option_index: optionIndex }, 'POST');
}

export async function chatLinkPreview(url) {
  return apiCall('chat_link_preview', { url }, 'POST');
}

// Chat contacts (for broadcast, etc.)
export async function chatContacts() {
  return apiCall('chat_contacts');
}

// Broadcast lists
export async function chatBroadcastCreate(name, members) {
  return apiCall('chat_broadcast_create', { name, members }, 'POST');
}
export async function chatBroadcastList() {
  return apiCall('chat_broadcast_list', {});
}
export async function chatBroadcastUpdate(broadcastId, name, members) {
  return apiCall('chat_broadcast_update', { broadcast_id: broadcastId, name, members }, 'POST');
}
export async function chatBroadcastDelete(broadcastId) {
  return apiCall('chat_broadcast_delete', { broadcast_id: broadcastId }, 'POST');
}
export async function chatBroadcastSend(broadcastId, content, type = 'text') {
  return apiCall('chat_broadcast_send', { broadcast_id: broadcastId, content, type }, 'POST');
}

// Channels
export async function chatCreateChannel(name, description = '') {
  return apiCall('chat_create_channel', { name, description }, 'POST');
}
export async function chatDiscoverChannels() {
  return apiCall('chat_discover_channels', {});
}
export async function chatJoinChannel(conversationId) {
  return apiCall('chat_join_channel', { conversation_id: conversationId }, 'POST');
}
export async function chatLeaveChannel(conversationId) {
  return apiCall('chat_leave_channel', { conversation_id: conversationId }, 'POST');
}
export async function chatChannelInfo(conversationId) {
  return apiCall('chat_channel_info', { conversation_id: conversationId });
}

// Media gallery
export async function chatMediaGallery(conversationId, type = null, limit = 50, offset = 0) {
  const params = { conversation_id: conversationId, limit, offset };
  if (type) params.type = type;
  return apiCall('chat_media_gallery', params, 'POST');
}

// Chat export
export async function chatExport(conversationId, format = 'txt') {
  return apiCall('chat_export', { conversation_id: conversationId, format });
}

// Group invite link
export async function chatGroupInviteLink(conversationId, regenerate = false) {
  return apiCall('chat_group_invite_link', { conversation_id: conversationId, regenerate }, 'POST');
}

// Join group via invite link
export async function chatJoinViaLink(code) {
  return apiCall('chat_join_via_link', { code }, 'POST');
}


// View-once
export async function chatViewOnceOpen(messageId) {
  return apiCall('chat_view_once_open', { message_id: messageId }, 'POST');
}

// Group call
export async function chatGroupCall(conversationId, callType = 'video') {
  return apiCall('chat_group_call', { conversation_id: conversationId, call_type: callType }, 'POST');
}

// Chat backup
export async function chatBackupCreate() {
  return apiCall('chat_backup_create', {}, 'POST');
}
export async function chatBackupList() {
  return apiCall('chat_backup_list', {});
}
export async function chatBackupDownload(backupId) {
  return apiCall('chat_backup_download', { backup_id: backupId });
}
export async function chatBackupDelete(backupId) {
  return apiCall('chat_backup_delete', { backup_id: backupId }, 'POST');
}
export async function chatBackupRestore(backupId) {
  return apiCall('chat_backup_restore', { backup_id: backupId }, 'POST');
}

// Photo sync from cloud
export async function drivePhotoSyncList(page = 1, limit = 50, month = null) {
  return apiCall('drive_photo_sync_list', { page, limit, ...(month ? { month } : {}) });
}

// Meetup / Hangout
export async function chatCreateMeetup(conversationId, title, datetime, location = '', description = '') {
  return apiCall('chat_create_meetup', { conversation_id: conversationId, title, datetime, location, description }, 'POST');
}

export async function chatMeetupRsvp(messageId, status) {
  return apiCall('chat_meetup_rsvp', { message_id: messageId, status }, 'POST');
}

// Shared Playlist
export async function chatCreatePlaylist(conversationId, name) {
  return apiCall('chat_create_playlist', { conversation_id: conversationId, name }, 'POST');
}

export async function chatPlaylistAddSong(messageId, title, artist = '', url = '') {
  return apiCall('chat_playlist_add_song', { message_id: messageId, title, artist, url }, 'POST');
}

export async function chatPlaylistRemoveSong(messageId, songIndex) {
  return apiCall('chat_playlist_remove_song', { message_id: messageId, song_index: songIndex }, 'POST');
}

export async function chatSearchMessages(conversationId, query) {
  return apiCall('chat_search_messages', { conversation_id: conversationId, query }, 'POST');
}

export async function chatPinMessage(messageId) {
  return apiCall('chat_pin_message', { message_id: messageId }, 'POST');
}

export async function chatPinnedMessages(conversationId) {
  return apiCall('chat_pinned_messages', { conversation_id: conversationId });
}

export async function chatSetWallpaper(conversationId, wallpaper) {
  return apiCall('chat_set_wallpaper', { conversation_id: conversationId, wallpaper }, 'POST');
}

export async function chatGetWallpaper(conversationId) {
  return apiCall('chat_get_wallpaper', { conversation_id: conversationId });
}

// ============================================================
// CALENDAR API
// ============================================================
export async function calCalendars() {
  return apiCall('cal_list_calendars');
}

export async function calCreateCalendar(name, color) {
  return apiCall('cal_create_calendar', { name, color }, 'POST');
}

export async function calEvents(start, end) {
  return apiCall('cal_list_events', { start, end });
}

export async function calEvent(eventId) {
  return apiCall('cal_get_event', { event_id: eventId });
}

export async function calCreateEvent(data) {
  return apiCall('cal_create_event', data, 'POST');
}

export async function calUpdateEvent(eventId, data) {
  return apiCall('cal_update_event', { event_id: eventId, ...data }, 'POST');
}

export async function calDeleteEvent(eventId) {
  return apiCall('cal_delete_event', { event_id: eventId }, 'POST');
}

export async function calRsvp(eventId, status) {
  return apiCall('cal_rsvp_event', { event_id: eventId, status }, 'POST');
}

export async function calMyEvents(limit = 10) {
  return apiCall('cal_today');
}

export async function calSearch(query) {
  return apiCall('cal_search', { query });
}

// TODO: Security concern — bearer token embedded in URL (see getAttachmentUrl comment)
export function calExportICSUrl(token) {
  // Returns the URL for the ICS feed subscription (token-authenticated)
  return `${API_URL}?action=cal_export_ics&token=${encodeURIComponent(token)}`;
}

// ============================================================
// FILES/DRIVE API (Chatyy Drive)
// ============================================================
export async function fileList(folderId = null) {
  return apiCall('drive_list', { parent_id: folderId });
}

export async function fileListAll() {
  return apiCall('drive_list_all');
}

export async function fileUpload(file, folderId = null) {
  const formData = new FormData();
  formData.append('action', 'drive_upload');
  if (file._raw) {
    formData.append('file', file._raw, file.name);
  } else if (file.uri) {
    formData.append('file', { uri: file.uri, type: file.mimeType || file.type || 'application/octet-stream', name: file.name || 'file' });
  } else {
    formData.append('file', file);
  }
  if (folderId) formData.append('parent_id', String(folderId));

  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 300s for uploads

  try {
    const res = await fetch(`${API_URL}?action=drive_upload`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, message: 'Servidor indisponivel' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Tempo limite excedido' };
    return { success: false, message: 'Connection error' };
  }
}

export function fileDownloadUrl(fileId) {
  return `${API_URL}?action=drive_download&id=${fileId}&token=${encodeURIComponent(authToken || '')}`;
}

export async function fileDelete(fileId) {
  return apiCall('drive_delete', { id: fileId }, 'POST');
}

export async function fileRestore(fileId) {
  return apiCall('drive_restore', { id: fileId }, 'POST');
}

export async function filePermanentDelete(fileId) {
  return apiCall('drive_permanent_delete', { id: fileId }, 'POST');
}

export async function fileCreateFolder(name, parentId = null) {
  return apiCall('drive_create_folder', { name, parent_id: parentId }, 'POST');
}

export async function fileRename(id, type, name) {
  return apiCall('drive_rename', { id, name }, 'POST');
}

export async function fileMove(fileId, folderId) {
  return apiCall('drive_move', { id: fileId, target_parent_id: folderId }, 'POST');
}

export async function fileStar(fileId) {
  return apiCall('drive_starred', { id: fileId, toggle: 1 }, 'POST');
}

export async function fileTrash() {
  return apiCall('drive_trash');
}

export async function fileStorageInfo() {
  return apiCall('drive_storage_info');
}

// Get presigned S3 URL for direct upload (bypasses server — celular → R2 direto)
export async function getPresignedUpload(filename, mimeType = 'image/jpeg', parentId = null) {
  const params = { filename, mime_type: mimeType };
  if (parentId) params.parent_id = parentId;
  return apiCall('drive_presigned_upload', params, 'POST');
}

// Upload file directly to R2 via presigned URL (Cloud/Drive)
export async function fileUploadDirect(file, folderId = null) {
  const filename = file.name || 'file';
  const mimeType = file.mimeType || file.type || 'application/octet-stream';
  const size = file.size || file.fileSize || 0;

  // 1. Get presigned URL
  const init = await getPresignedUpload(filename, mimeType, folderId);
  if (!init.success || !init.data?.upload_url) {
    // Fallback to legacy upload via server
    return fileUpload(file, folderId);
  }

  // 2. Upload directly to R2
  try {
    const body = file._raw || file.uri ? await fetch(file.uri).then(r => r.blob()) : file;
    const putRes = await fetch(init.data.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body,
    });
    if (!putRes.ok) throw new Error(`R2 PUT failed: ${putRes.status}`);

    // 3. Confirm upload
    if (init.data.file_id) {
      await confirmUpload(init.data.file_id);
    }
    return { success: true, data: { file_id: init.data.file_id, url: init.data.upload_url } };
  } catch (e) {
    // Fallback to legacy
    return fileUpload(file, folderId);
  }
}

export async function confirmUpload(fileId) {
  return apiCall('drive_confirm_upload', { file_id: fileId }, 'POST');
}

// Batch confirm multiple S3 uploads at once (for background upload queue)
export async function confirmUploadBatch(fileIds) {
  return apiCall('drive_confirm_batch', { file_ids: JSON.stringify(fileIds) }, 'POST');
}

// Batch presigned S3 URLs — up to 50 files in one call (40x faster backup)
export async function getPresignedBatch(files) {
  return apiCall('drive_presigned_batch', { files: JSON.stringify(files) }, 'POST');
}

// Upload photo/video directly to Photo Backup folder (bypasses S3)
export async function uploadPhotoBackup(file) {
  const formData = new FormData();
  formData.append('action', 'drive_upload_photo_backup');
  if (file.uri) {
    formData.append('file', { uri: file.uri, type: file.mimeType || file.type || 'image/jpeg', name: file.name || 'photo.jpg' });
  } else {
    formData.append('file', file);
  }
  if (file.deviceName) formData.append('device_name', file.deviceName);

  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch(`${API_URL}?action=drive_upload_photo_backup`, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, message: 'Server unavailable' }; }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { success: false, message: 'Timeout' };
    return { success: false, message: 'Connection error' };
  }
}

// Resumable upload: init session → returns upload_url + session_id
export async function driveInitUpload(filename, mimeType, totalSize, contentHash = null) {
  return apiCall('drive_init_upload', {
    filename, mime_type: mimeType, total_size: totalSize, content_hash: contentHash
  }, 'POST');
}

// Resumable upload: confirm completion
export async function driveCompleteUpload(fileId, contentHash = null) {
  return apiCall('drive_complete_upload', { file_id: fileId, content_hash: contentHash }, 'POST');
}

// Resumable upload: get resume info (bytes_uploaded + new upload_url)
export async function driveResumeUpload(sessionId) {
  return apiCall('drive_resume_upload', { session_id: sessionId }, 'POST');
}

// Content deduplication: check which hashes already exist on server
export async function driveCheckDuplicates(items) {
  return apiCall('drive_check_duplicates', { items }, 'POST');
}

// ML Photo Analysis (Google Photos style)
export async function photoAnalyze(fileId) {
  return apiCall('photo_analyze', { file_id: fileId }, 'POST');
}

export async function photoAnalyzeBatch(limit = 20) {
  return apiCall('photo_analyze_batch', { limit }, 'POST');
}

export async function photoSearchML(query, page = 1, limit = 50) {
  return apiCall('photo_search_ml', { query, page, limit }, 'POST');
}

export async function unifiedSearch(query, limit = 5) {
  return apiCall('unified_search', { query, limit }, 'POST');
}

// AI Features
export async function aiCategorize(subject, from, snippet) {
  return apiCall('ai_categorize', { subject, from, snippet }, 'POST');
}

export async function aiSmartReply(subject, body) {
  return apiCall('ai_smart_reply', { subject, body }, 'POST');
}

export async function aiSummarize(messages) {
  return apiCall('ai_summarize', { messages }, 'POST');
}

export async function translate(text, target = 'pt-BR') {
  return apiCall('translate', { text, target }, 'POST');
}

export async function photoFaces() {
  return apiCall('photo_faces', {}, 'POST');
}

export async function photoSuggestTags() {
  return apiCall('photo_suggest_tags', {}, 'POST');
}

export async function fileSearch(query) {
  return apiCall('drive_search', { q: query });
}

export async function fileRecent() {
  return apiCall('drive_recent');
}

export async function fileShare(fileId, email, permission = 'view') {
  return apiCall('drive_share', { id: fileId, type: email ? 'email' : 'public', email, permission }, 'POST');
}

export async function fileSharedWithMe() {
  return apiCall('drive_shared_with_me');
}

export async function fileSharedByMe() {
  return apiCall('drive_shared_with_me');
}

export async function fileGetShared(fileId) {
  return apiCall('drive_get_shared', { id: fileId });
}

export async function fileUnshare(fileId, email) {
  return apiCall('drive_unshare', { id: fileId, email }, 'POST');
}

export async function filePhotos(type = 'all', page = 1, limit = 50) {
  return apiCall('drive_photos', { type, page, limit });
}

export async function fileEmptyTrash() {
  return apiCall('drive_empty_trash', {}, 'POST');
}

export async function fileVersions(fileId) {
  return apiCall('drive_file_versions', { file_id: fileId });
}

export async function fileRestoreVersion(fileId, versionId) {
  return apiCall('drive_restore_version', { file_id: fileId, version_id: versionId }, 'POST');
}

// ─── ONE AI Assistant ───
export async function oneChat(message, conversationId = null, imageBase64 = null, imageMimeType = null) {
  const tz = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone || 'America/Sao_Paulo';
  const locale = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.locale || '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };
    const body = { action: 'one_chat', message, conversation_id: conversationId, timezone: tz, locale };
    if (imageBase64) {
      body.image_data = imageBase64;
      body.image_mime_type = imageMimeType || 'image/jpeg';
    }
    const res = await fetch(`${API_URL}?action=one_chat`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { success: false, message: 'Tempo limite excedido. Tente novamente.' };
    }
    return { success: false, message: 'Erro de conexao' };
  }
}

export async function oneHistory(conversationId = null) {
  return conversationId
    ? apiCall('one_history', { conversation_id: conversationId })
    : apiCall('one_history');
}

export async function oneStatus() {
  return apiCall('one_status');
}

// ElevenLabs TTS — returns blob URL (web) or null on failure
export async function oneTTS(text) {
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  try {
    const res = await fetch(`${API_URL}?action=one_tts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      credentials: 'include',
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn('[api] oneTTS error:', e?.message);
    return null;
  }
}

// ElevenLabs TTS — returns direct URL for native playback (expo-av / Audio)
export function oneTTSUrl(text) {
  const token = authToken || '';
  return `${API_URL}?action=one_tts&text=${encodeURIComponent(text)}&token=${token}`;
}

// ============================================================
// FEED API
// ============================================================
export async function feedCreatePost(formData) {
  formData.append('action', 'feed_create_post');
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    const resp = await fetch(`${API_URL}?action=feed_create_post`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

export async function feedList(page = 1, limit = 20) {
  return apiCall('feed_list', { page, limit }, 'POST');
}

export async function feedUserPosts(email, page = 1) {
  return apiCall('feed_user_posts', { email, page }, 'POST');
}

export async function feedLike(postId) {
  return apiCall('feed_like', { post_id: postId }, 'POST');
}

export async function feedLikers(postId) {
  return apiCall('feed_likers', { post_id: postId }, 'POST');
}
export async function feedView(postId) {
  return apiCall('feed_view', { post_id: postId }, 'POST');
}

export async function feedComment(postId, content, replyToId) {
  return apiCall('feed_comment', { post_id: postId, content, reply_to_id: replyToId }, 'POST');
}

export async function feedComments(postId, page = 1) {
  return apiCall('feed_comments', { post_id: postId, page }, 'POST');
}

export async function feedDeleteComment(commentId) {
  return apiCall('feed_delete_comment', { comment_id: commentId }, 'POST');
}

export async function feedDeletePost(postId) {
  return apiCall('feed_delete_post', { post_id: postId }, 'POST');
}

export async function feedBookmark(postId) {
  return apiCall('feed_bookmark', { post_id: postId }, 'POST');
}

export async function feedBookmarks(page = 1) {
  return apiCall('feed_bookmarks', { page }, 'POST');
}

// ============================================================
// FOLLOW / PROFILE API
// ============================================================
export async function followUser(targetEmail) {
  return apiCall('follow_user', { target_email: targetEmail }, 'POST');
}
export async function unfollowUser(targetEmail) {
  return apiCall('unfollow_user', { target_email: targetEmail }, 'POST');
}
export async function getFollowers(email, page = 1) {
  return apiCall('get_followers', { email, page });
}
export async function getFollowing(email, page = 1) {
  return apiCall('get_following', { email, page });
}
export async function getPublicProfile(email) {
  return apiCall('get_public_profile', { email });
}
export async function getMutualFollowers(email) {
  return apiCall('mutual_followers', { target_email: email });
}

// ============================================================
// LIVE STREAMING API
// ============================================================
export async function liveStart(title) { return apiCall('live_start', { title }, 'POST'); }
export async function liveEnd(sessionId) { return apiCall('live_end', { session_id: sessionId }, 'POST'); }
export async function liveList() { return apiCall('live_list', {}, 'POST'); }
export async function liveUpdateViewers(sessionId, count) { return apiCall('live_update_viewers', { session_id: sessionId, viewer_count: count }, 'POST'); }
export async function liveSendChat(sessionId, content) { return apiCall('live_send_chat', { session_id: sessionId, content }, 'POST'); }
export async function liveChatHistory(sessionId, limit = 50) { return apiCall('live_chat_history', { session_id: sessionId, limit }, 'POST'); }

// ============================================================
// CALL HISTORY
// ============================================================
export async function callHistoryList(limit = 100, offset = 0) {
  return apiCall('chat_call_history_list', { limit, offset }, 'POST');
}
export async function callHistoryAdd(callData) {
  return apiCall('chat_call_history_add', {
    contact_email: callData.contactEmail,
    contact_name: callData.contactName || callData.contactEmail,
    call_id: callData.callId || '',
    type: callData.type || 'outgoing',
    video: callData.video ? 1 : 0,
    timestamp: callData.timestamp || Date.now(),
    duration: callData.duration || 0,
    is_group: callData.isGroup ? 1 : 0,
    participants: callData.participants || [],
  }, 'POST');
}
export async function callHistoryDelete(id) {
  return apiCall('chat_call_history_delete', { id }, 'POST');
}
export async function callHistoryClear() {
  return apiCall('chat_call_history_clear', {}, 'POST');
}

// ============================================================
// VoIP DIALER
// ============================================================
export async function voipCall(toNumber, contactName = '', useCallback = false) {
  return apiCall('voip_call', { to_number: toNumber, contact_name: contactName, use_callback: useCallback ? '1' : '' }, 'POST');
}
export async function voipToken() {
  return apiCall('voip_token', {}, 'POST');
}
export async function voipMinutesRemaining() {
  return apiCall('voip_minutes_remaining', {}, 'POST');
}
export async function voipUpdateDuration(callId, durationSeconds, status = 'completed') {
  return apiCall('voip_update_duration', { call_id: callId, duration_seconds: durationSeconds, status }, 'POST');
}

// ============================================================
// DEEZER MUSIC SEARCH (for status music)
// ============================================================
export async function searchDeezerMusic(query) {
  if (!query || query.trim().length < 2) return [];

  // On web, Deezer API blocks CORS (no Access-Control-Allow-Origin header),
  // so always use our backend proxy. On native, try direct first.
  if (Platform.OS !== 'web') {
    try {
      const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=20&output=json`);
      if (response.ok) {
        const data = await response.json();
        if (!data.error && data.data && data.data.length > 0) {
          return data.data.map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artist?.name || '',
            previewUrl: track.preview || '',
            coverUrl: track.album?.cover_medium || track.album?.cover || '',
            duration: track.duration || 30,
          }));
        }
      }
    } catch (err) {
      console.warn('[Deezer] Direct API failed, using proxy:', err.message);
    }
  }

  // Backend proxy (works on all platforms, avoids CORS on web)
  try {
    const r = await apiCall('deezer_search', { q: query }, 'POST');
    if (r?.success && Array.isArray(r.data?.tracks)) return r.data.tracks;
    // If API returned success but no tracks array, return empty
    if (r?.success) return [];
    console.warn('[Deezer] Backend proxy returned error:', r?.message, JSON.stringify(r));
  } catch (err) {
    console.warn('[Deezer] Backend proxy failed:', err.message);
  }
  return [];
}

// ============================================================
// USER SEARCH (Chatyy)
// ============================================================
export async function searchUsers(query) { return apiCall('search_users', { q: query }); }

// ============================================================
// PLANS API
// ============================================================
export async function planInfo() { return apiCall('plan_info'); }
export async function planUpgrade(plan) { return apiCall('plan_upgrade', { plan }, 'POST'); }
export async function planCancel() { return apiCall('plan_cancel', {}, 'POST'); }
export async function planFamilyAdd(email) { return apiCall('plan_family_add', { email }, 'POST'); }
export async function planFamilyRemove(email) { return apiCall('plan_family_remove', { email }, 'POST'); }
export async function planFamilyList() { return apiCall('plan_family_list'); }
export async function planBackupList(conversationId = null) { return apiCall('plan_backup_list', { conversation_id: conversationId }); }
export async function planBackupRestore(backupId) { return apiCall('plan_backup_restore', { backup_id: backupId }, 'POST'); }
export async function planBackupDelete(backupId) { return apiCall('plan_backup_delete', { backup_id: backupId }, 'POST'); }

// ============================================================
// STRIPE API
// ============================================================
export async function stripeCheckout(plan) { return apiCall('stripe_checkout', { plan }, 'POST'); }
export async function stripePortal() { return apiCall('stripe_portal', {}, 'POST'); }
export async function stripeStatus() { return apiCall('stripe_status'); }
export async function stripeSubscribe(plan, paymentMethodId, storageOpts, billingPeriod) { return apiCall('stripe_subscribe', { plan, payment_method_id: paymentMethodId, billing_period: billingPeriod || 'monthly', ...(storageOpts || {}) }, 'POST'); }
export async function stripeSubscriptionInfo() { return apiCall('stripe_subscription_info'); }
export async function stripeUpdateCard(paymentMethodId) { return apiCall('stripe_update_card', { payment_method_id: paymentMethodId }, 'POST'); }
export async function stripeCancelSubscription() { return apiCall('stripe_cancel_subscription', {}, 'POST'); }
export async function stripeReactivate() { return apiCall('stripe_reactivate', {}, 'POST'); }
export async function stripeSavedCard() { return apiCall('stripe_saved_card'); }
export async function stripeUpgrade(plan, storageGb) { return apiCall('stripe_upgrade', { plan, storage_gb: storageGb || undefined }, 'POST'); }

// ============================================================
// APPLE IAP API
// ============================================================
export async function iapValidateReceipt(receipt, productId) { return apiCall('iap_validate_receipt', { receipt, product_id: productId }, 'POST'); }
export async function iapRestorePurchases(receipt) { return apiCall('iap_restore_purchases', { receipt }, 'POST'); }
export async function iapSubscriptionInfo() { return apiCall('iap_subscription_info'); }

// ============================================================
// QR CODE AUTH
// ============================================================
export async function qrGenerate() { return apiCall('qr_generate', {}, 'POST'); }
export async function qrCheck(token) { return apiCall('qr_check', { token }, 'POST'); }
export async function qrConfirm(token) { return apiCall('qr_confirm', { token }, 'POST'); }

// ============================================================
// CHECK CONTACTS (Chatyy registration lookup)
// ============================================================
export async function checkContacts(emails, phones) {
  return apiCall('check_contacts', { emails: emails || [], phones: phones || [] }, 'POST');
}

// ============================================================
// NOTES API
// ============================================================
export async function notesList(filters = {}) { return apiCall('notes_list', filters); }
export async function notesCreate(data) { return apiCall('notes_create', data, 'POST'); }
export async function notesUpdate(id, data) { return apiCall('notes_update', { id, ...data }, 'POST'); }
export async function notesDelete(id) { return apiCall('notes_delete', { id }, 'POST'); }
export async function notesExportPdf(id) { return apiCall('notes_export_pdf', { id }); }
export async function notesSendEmail(id, to_email) { return apiCall('notes_send_email', { id, to_email }, 'POST'); }
export async function notebooksList() { return apiCall('notebooks_list'); }
export async function notebooksCreate(data) { return apiCall('notebooks_create', data, 'POST'); }
export async function notebooksUpdate(id, data) { return apiCall('notebooks_update', { id, ...data }, 'POST'); }
export async function notebooksDelete(id) { return apiCall('notebooks_delete', { id }, 'POST'); }

// Notebook Pages (drawing + text)
export async function notebookPagesList(notebookId) { return apiCall('notebook_pages_list', { notebook_id: notebookId }); }
export async function notebookPageGet(pageId) { return apiCall('notebook_page_get', { page_id: pageId }); }
export async function notebookPageSave(pageId, data) { return apiCall('notebook_page_save', { page_id: pageId, ...data }, 'POST'); }
export async function notebookPageCreate(notebookId, background) { return apiCall('notebook_page_create', { notebook_id: notebookId, background: background || 'lined' }, 'POST'); }
export async function notebookPageDelete(pageId) { return apiCall('notebook_page_delete', { page_id: pageId }, 'POST'); }

// Referral system
export async function getReferralCode() { return apiCall('get_referral_code'); }
export async function applyReferral(code) { return apiCall('apply_referral', { code }, 'POST'); }


// VoIP SIP credentials - direct fetch (bypass Cloudflare for speed)
export async function voipSipCredentials() {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${BASE_URL}/api/email.php?action=voip_sip_credentials`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'voip_sip_credentials' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return await r.json();
  } catch (e) { clearTimeout(timeout); return { success: false, message: e.message }; }
}

// App init (combined endpoint)
export async function appInit() {
  return apiCall('app_init');
}

// Bootstrap: single request returns ALL data (Redis-cached 60s on server)
// Use this on every app open for instant data
export async function bootstrap() {
  const r = await apiCall('bootstrap');
  if (r?.success && r.data) {
    // Cache locally for offline/instant access
    try {
      const { setString, setJSON } = require('./mmkv');
      if (r.data.conversations) setString('chat_conversations', JSON.stringify(r.data.conversations));
      if (r.data.profile) setJSON('omc_profile', { data: r.data.profile, ts: Date.now() });
      if (r.data.call_history) setJSON('omc_call_history', { data: r.data.call_history, ts: Date.now() });
      if (r.data.folders) {
        const { setCache } = require('./cache');
        setCache('email_folders', r.data.folders, 600000).catch(() => {});
      }
    } catch {}
  }
  return r;
}

// Wait for token ready — resolves once authToken is loaded from storage
export async function waitForTokenReady() {
  return _tokenReadyPromise;
}

// Chat send with client_message_id for dedup
export async function chatSendDedup(conversationId, content, type, replyId, mentions, files, disappearing, clientMessageId) {
  return apiCall('chat_send', {
    conversation_id: conversationId,
    content, type: type || 'text',
    reply_to_id: replyId || null,
    mentions: mentions || [],
    files: files || null,
    disappearing_timer: disappearing || null,
    client_message_id: clientMessageId || null,
  }, 'POST');
}

// Incremental sync — get all chat events since last_seq
export async function chatSync(lastSeq = 0, limit = 100) {
  return apiCall('chat_sync', { last_seq: lastSeq, limit }, 'POST');
}

// ─── Documents ───
export async function docsList(params = {}) { return apiCall('docs_list', params); }
export async function docsCreate(data) {
  // Accept both object and legacy (title, type) signatures
  if (typeof data === 'string') data = { title: data, type: 'document' };
  return apiCall('docs_create', data, 'POST');
}
export async function docsRename(docId, title) { return apiCall('docs_rename', { doc_id: docId, title }, 'POST'); }
export async function docsTrash(docId) { return apiCall('docs_trash', { doc_id: docId }, 'POST'); }
export async function docsDuplicate(docId) { return apiCall('docs_duplicate', { doc_id: docId }, 'POST'); }

// ─── Parental Controls ───
export async function parentalCreateChild(childName, childBirthday) { return apiCall('parental_create_child', { child_name: childName, child_birthday: childBirthday }, 'POST'); }
export async function parentalListChildren() { return apiCall('parental_list_children'); }
export async function parentalChildChats(childEmail) { return apiCall('parental_child_chats', { child_email: childEmail }); }
export async function parentalChildMessages(childEmail, conversationId, limit = 50) { return apiCall('parental_child_messages', { child_email: childEmail, conversation_id: conversationId, limit }); }
export async function parentalAlerts(childEmail) { return apiCall('parental_alerts', childEmail ? { child_email: childEmail } : {}); }
export async function parentalMarkAlertRead(alertId) { return apiCall('parental_mark_alert_read', { alert_id: alertId }, 'POST'); }
export async function parentalUpdateRestrictions(childEmail, restrictions) { return apiCall('parental_update_restrictions', { child_email: childEmail, ...restrictions }, 'POST'); }
export async function parentalGetRestrictions(childEmail) { return apiCall('parental_get_restrictions', { child_email: childEmail }); }
export async function parentalMyStatus() { return apiCall('parental_my_status'); }
export async function parentalRevokeChild(childEmail) { return apiCall('parental_revoke_child', { child_email: childEmail }, 'POST'); }
export async function parentalScreenTime(childEmail) { return apiCall('parental_screen_time', { child_email: childEmail }); }
export async function parentalCallHistory(childEmail) { return apiCall('parental_call_history', { child_email: childEmail }); }
export async function parentalContactWhitelist(childEmail) { return apiCall('parental_contact_whitelist', { child_email: childEmail }); }
export async function parentalAddContact(childEmail, contactEmail) { return apiCall('parental_contact_whitelist', { child_email: childEmail, contact_email: contactEmail }, 'POST'); }
export async function parentalRemoveContact(childEmail, contactEmail) { return apiCall('parental_remove_contact', { child_email: childEmail, contact_email: contactEmail }, 'POST'); }
export async function parentalSetTimeLimits(childEmail, data) { return apiCall('parental_set_time_limits', { child_email: childEmail, ...data }, 'POST'); }
export async function parentalActivitySummary(childEmail) { return apiCall('parental_activity_summary', { child_email: childEmail }); }
export async function parentalUpdateLocation(lat, lng, accuracy, battery) { return apiCall('parental_update_location', { latitude: lat, longitude: lng, accuracy, battery_level: battery }, 'POST'); }
export async function parentalGetLocation(childEmail) { return apiCall('parental_get_location', { child_email: childEmail }); }
export async function parentalGeofences(childEmail) { return apiCall('parental_geofences', { child_email: childEmail }); }

// SOS Emergency System
export async function parentalSOS(type, message, latitude, longitude, accuracy, battery) {
  return apiCall('parental_sos', { type, message, latitude, longitude, accuracy, battery }, 'POST');
}
export async function parentalSOSResolve(sosId) { return apiCall('parental_sos_resolve', { sos_id: sosId }, 'POST'); }
export async function parentalSOSHistory(childEmail) { return apiCall('parental_sos_history', { child_email: childEmail }); }
export async function parentalEmergencyContacts(childEmail) { return apiCall('parental_emergency_contacts', { child_email: childEmail }); }
export async function parentalAddEmergencyContact(childEmail, name, phone, relationship, isPolice) {
  return apiCall('parental_emergency_contacts', { child_email: childEmail, name, phone, relationship, is_police: isPolice }, 'POST');
}

// Kids TV
export async function kidsTVChannels(category) { return apiCall('kids_tv_channels', category ? { category } : {}); }
export async function kidsTVVideos(channelId) { return apiCall('kids_tv_videos', { channel_id: channelId }); }
export async function kidsTVFeatured() { return apiCall('kids_tv_featured'); }

// Professora ONE Kids
export async function oneKidsChat(message, topic, imageUri) {
  if (imageUri) {
    const formData = new FormData();
    formData.append('message', message);
    formData.append('topic', topic || '');
    formData.append('image', { uri: imageUri, name: 'homework.jpg', type: 'image/jpeg' });
    const res = await fetch(`${API_URL}?action=one_kids_chat`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: formData,
    });
    return res.json();
  }
  return apiCall('one_kids_chat', { message, topic }, 'POST');
}
export async function parentalUploadDocument(accountId, documentType, fileUri) {
  const formData = new FormData();
  formData.append('account_id', accountId);
  formData.append('document_type', documentType);
  formData.append('document', { uri: fileUri, name: 'document.jpg', type: 'image/jpeg' });
  const headers = getAuthHeaders();
  const res = await fetch(API_URL + '?action=parental_upload_document', { method: 'POST', headers, body: formData, credentials: 'include' });
  return res.json();
}

// ─── IVR (Interactive Voice Response) ───
export async function ivrList() { return apiCall('ivr_list'); }
export async function ivrCreate(data) { return apiCall('ivr_create', data, 'POST'); }
export async function ivrUpdate(data) { return apiCall('ivr_update', data, 'POST'); }
export async function ivrUpdateOptions(menuId, options) { return apiCall('ivr_update_options', { menu_id: menuId, options }, 'POST'); }
export async function ivrDelete(menuId) { return apiCall('ivr_delete', { menu_id: menuId }, 'POST'); }
export async function ivrLogs(menuId, limit = 50) { return apiCall('ivr_logs', { menu_id: menuId, limit }); }

// ─── Communities ───
export async function communityCreate(name, description = '') {
  return apiCall('community_create', { name, description }, 'POST');
}
export async function communityList() {
  return apiCall('community_list');
}
export async function communityAddGroup(communityId, conversationId) {
  return apiCall('community_add_group', { community_id: communityId, conversation_id: conversationId }, 'POST');
}
export async function communityMembers(communityId) {
  return apiCall('community_members', { community_id: communityId });
}

// ─── Stickers ───
export async function stickerPacks() {
  return apiCall('sticker_packs');
}
export async function stickerList(packId) {
  return apiCall('sticker_list', { pack_id: packId });
}
export async function stickerAddPack(packId) {
  return apiCall('sticker_add_pack', { pack_id: packId }, 'POST');
}

// ─── Channels ───
export async function channelCreate(name, description = '') {
  return apiCall('channel_create', { name, description }, 'POST');
}
export async function channelList() {
  return apiCall('channel_list');
}
export async function channelSubscribe(channelId) {
  return apiCall('channel_subscribe', { channel_id: channelId }, 'POST');
}
export async function channelPost(channelId, content, type = 'text') {
  return apiCall('channel_post', { channel_id: channelId, content, type }, 'POST');
}
export async function channelMessages(channelId, limit = 50) {
  return apiCall('channel_messages', { channel_id: channelId, limit });
}

// ─── Security / 2FA ───
export async function enable2fa() {
  return apiCall('enable_2fa', {}, 'POST');
}
export async function verify2fa(code) {
  return apiCall('verify_2fa', { code }, 'POST');
}
export async function disable2fa(password) {
  return apiCall('disable_2fa', { password }, 'POST');
}
export async function check2faStatus() {
  return apiCall('check_2fa_status');
}
export async function verifyLogin2fa(tempToken, code) {
  return apiCall('verify_login_2fa', { temp_token: tempToken, code }, 'POST');
}
export async function getLoginHistory() {
  return apiCall('login_history');
}

// ─── Explore / Social ───
export async function feedExplore(page = 1, category = '') {
  return apiCall('feed_explore', { page, category }, 'POST');
}
export async function feedHashtagPosts(hashtag, page = 1) {
  return apiCall('hashtag_posts', { hashtag, page }, 'POST');
}
export async function trendingHashtags(limit = 20) {
  return apiCall('trending_hashtags', { limit }, 'POST');
}
export async function closeFriendsList() {
  return apiCall('close_friends_list', {}, 'POST');
}
export async function closeFriendsAdd(email) {
  return apiCall('close_friends_add', { email }, 'POST');
}
export async function closeFriendsRemove(email) {
  return apiCall('close_friends_remove', { email }, 'POST');
}

// ─── Chatyy Pay ───
export async function paymentSend(toEmail, amount, currency = 'BRL') {
  return apiCall('payment_send', { to_email: toEmail, amount, currency }, 'POST');
}
export async function paymentHistory(limit = 50) {
  return apiCall('payment_history', { limit });
}
export async function paymentGeneratePix(amount) {
  return apiCall('payment_generate_pix', { amount }, 'POST');
}

// ─── Business ───
export async function businessSetup(data) {
  return apiCall('business_setup', data, 'POST');
}
export async function businessAnalytics() {
  return apiCall('business_analytics');
}
export async function businessAutoReply(message) {
  return apiCall('business_auto_reply', { message }, 'POST');
}

// ─── Premium ───
export async function premiumSubscribe() {
  return apiCall('premium_subscribe', {}, 'POST');
}
export async function premiumStatus() {
  return apiCall('premium_status');
}

// ─── Ads ───
export async function adCreate(data) {
  return apiCall('ad_create', data, 'POST');
}
export async function adList() {
  return apiCall('ad_list');
}
