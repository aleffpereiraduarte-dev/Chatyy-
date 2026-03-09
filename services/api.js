import { Platform } from 'react-native';

const API_URL = 'https://mail.onemundo.com.br/api/email.php';
export const BASE_URL = 'https://mail.onemundo.com.br';
const TIMEOUT_MS = 30000;

let sessionCookie = '';
let authToken = '';
let csrfToken = ''; // CSRF protection token from server
let savedCredentials = null; // For auto-relogin on session expiry

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

// Initialize token from storage and clean up any old plaintext credentials
(async () => {
  const stored = await getStoredToken();
  if (stored) authToken = stored;
  // Clean up legacy plaintext credentials from localStorage
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.removeItem('mail_creds');
      // Also clean passwords from stored accounts
      const accts = getStoredAccounts();
      if (accts.some(a => a.password)) {
        storeAccounts(accts.map(({ password, ...rest }) => rest));
      }
    }
  } catch {}
})();

let _reloginPromise = null;

async function _rawApiCall(action, params = {}, method = 'GET') {
  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (method === 'POST' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

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
  if (result.status === 401 && action !== 'login' && action !== 'check_auth') {
    const creds = savedCredentials;
    if (creds?.email && creds?.password) {
      // Use a shared promise to deduplicate concurrent relogin attempts
      if (!_reloginPromise) {
        _reloginPromise = _rawApiCall('login', { email: creds.email, password: creds.password }, 'POST')
          .catch(() => ({ data: { success: false } }))
          .finally(() => { _reloginPromise = null; });
      }
      const loginResult = await _reloginPromise;
      if (loginResult.data?.success) {
        const retry = await _rawApiCall(action, params, method);
        return retry.data;
      }
    }
  }

  return result.data;
}

export async function login(email, password) {
  const r = await apiCall('login', { email, password }, 'POST');
  if (r.success) {
    // Save credentials for auto-relogin when session expires
    savedCredentials = { email, password };
    storeCredentials(email, password);
    const token = r?.data?.token || r?.token;
    if (token) {
      authToken = token;
      await storeToken(token);
    }
    // Multi-account: store this account
    const name = r.data?.name || r.data?.email || email;
    upsertAccount(email, password, name);
    setActiveAccountEmail(email);
  }
  return r;
}

export async function signup(username, password, name, domain = 'onemundo.com.br', extra = {}) {
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

export async function checkUsername(username, domain = 'onemundo.com.br') {
  return apiCall('check_username', { username, domain });
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
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

// Thread view
export async function getThread(uid, folder = 'INBOX') {
  return apiCall('get_thread', { uid, folder });
}

// Attachment download URL
export function getAttachmentUrl(uid, folder, part) {
  return `${API_URL}?action=attachment_download&uid=${uid}&folder=${encodeURIComponent(folder)}&part=${part}&token=${authToken || ''}`;
}

// ---- Forgot Password ----
export async function forgotPasswordInitiate(email) {
  return apiCall('forgot_password_initiate', { email }, 'POST');
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
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(e)}&t=${Date.now()}`;
}

export function getAvatarUrlForEmail(email) {
  if (!email) return null;
  return `${API_URL}?action=get_avatar&email=${encodeURIComponent(email)}`;
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
export function getExportUrl(uid, folder) {
  return `${API_URL}?action=export_email&uid=${uid}&folder=${encodeURIComponent(folder)}&token=${authToken || ''}`;
}

// Active sessions
export async function getSessionsList() {
  return apiCall('sessions_list');
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
  const params = {};
  if (search) params.search = search;
  if (includeArchived) params.include_archived = 1;
  return apiCall('chat_list', params);
}

export async function chatCreate(members, name = '', type = 'direct') {
  return apiCall('chat_create', { members, name, type }, 'POST');
}

export async function chatMessages(conversationId, limit = 50, beforeId = null) {
  const params = { conversation_id: conversationId, limit };
  if (beforeId) params.before_id = beforeId;
  return apiCall('chat_messages', params);
}

export async function chatSend(conversationId, content, type = 'text', replyToId = null, mentions = null) {
  const payload = { conversation_id: conversationId, content, type, reply_to_id: replyToId };
  if (mentions && Array.isArray(mentions) && mentions.length > 0) {
    payload.mentions = JSON.stringify(mentions);
  }
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

export async function chatDelete(messageId) {
  return apiCall('chat_delete_message', { message_id: messageId }, 'POST');
}

export async function chatReact(messageId, emoji) {
  return apiCall('chat_react', { message_id: messageId, emoji }, 'POST');
}

export async function chatRead(conversationId, messageId) {
  return apiCall('chat_mark_read', { conversation_id: conversationId, message_id: messageId }, 'POST');
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

export async function chatMute(conversationId) {
  return apiCall('chat_mute', { conversation_id: conversationId }, 'POST');
}

export async function chatPin(conversationId, messageId) {
  return apiCall('chat_pin', { conversation_id: conversationId, message_id: messageId }, 'POST');
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

// Status (WhatsApp-style stories)
export async function statusPublish(content, type = 'text', bgColor = '#25D366') {
  return apiCall('status_publish', { content, type, bg_color: bgColor }, 'POST');
}

export async function statusUpload(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('action', 'status_upload');
  const resp = await fetch(`${API_URL}`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  return resp.json();
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

export async function chatGetSettings() {
  return apiCall('chat_get_settings');
}

export async function chatUpdateSettings(data) {
  return apiCall('chat_update_settings', data, 'POST');
}

export async function chatUploadFile(conversationId, file, content = '', viewOnce = false) {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
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

export function calExportICSUrl(token) {
  // Returns the URL for the ICS feed subscription (token-authenticated)
  return `${API_URL}?action=cal_export_ics&token=${encodeURIComponent(token)}`;
}

// ============================================================
// FILES/DRIVE API
// ============================================================
export async function fileList(folderId = null) {
  return apiCall('file_list', { folder_id: folderId });
}

export async function fileUpload(file, folderId = null) {
  const formData = new FormData();
  formData.append('action', 'file_upload');
  if (file._raw) {
    formData.append('file', file._raw, file.name);
  } else if (file.uri) {
    formData.append('file', { uri: file.uri, type: file.mimeType || file.type || 'application/octet-stream', name: file.name || 'file' });
  } else {
    formData.append('file', file);
  }
  if (folderId) formData.append('folder_id', String(folderId));

  const headers = {};
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  // No Content-Type — browser/RN sets multipart boundary automatically

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s for uploads

  try {
    const res = await fetch(`${API_URL}?action=file_upload`, {
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
  return `${API_URL}?action=file_download&file_id=${fileId}&token=${encodeURIComponent(authToken || '')}`;
}

export async function fileDelete(fileId) {
  return apiCall('file_delete', { file_id: fileId }, 'POST');
}

export async function fileRestore(fileId) {
  return apiCall('file_restore', { file_id: fileId }, 'POST');
}

export async function filePermanentDelete(fileId) {
  return apiCall('file_permanent_delete', { file_id: fileId }, 'POST');
}

export async function fileCreateFolder(name, parentId = null) {
  return apiCall('file_create_folder', { name, parent_id: parentId }, 'POST');
}

export async function fileRename(id, type, name) {
  return apiCall('file_rename', { id, type, name }, 'POST');
}

export async function fileMove(fileId, folderId) {
  return apiCall('file_move', { file_id: fileId, folder_id: folderId }, 'POST');
}

export async function fileStar(fileId) {
  return apiCall('file_star', { file_id: fileId }, 'POST');
}

export async function fileTrash() {
  return apiCall('file_trash');
}

export async function fileStorageInfo() {
  return apiCall('file_storage_info');
}

export async function fileSearch(query) {
  return apiCall('file_search', { query });
}

export async function fileRecent() {
  return apiCall('file_recent');
}

export async function fileShare(fileId, email, permission = 'view') {
  return apiCall('file_share', { file_id: fileId, email, permission }, 'POST');
}

// ─── ONE AI Assistant ───
export async function oneChat(message, conversationId = null) {
  return apiCall('one_chat', { message, conversation_id: conversationId }, 'POST');
}

export async function oneHistory(conversationId = null) {
  return conversationId
    ? apiCall('one_history', { conversation_id: conversationId })
    : apiCall('one_history');
}

export async function oneStatus() {
  return apiCall('one_status');
}
