/**
 * chatBackupCloud — Cloud (iCloud Drive / Google Drive) chat backup engine.
 *
 * Closes the WhatsApp parity gap "cloud-provider backup" tracked in
 * /tmp/gap_chat_whatsapp.md. The previous self-host path (`chat_backup_*` +
 * `services/backupEngine.js`) still works; this module sits alongside it
 * and writes the same encrypted blob into the user's own iCloud Drive
 * (iOS) or Google Drive (Android + iOS) so they can restore on a new phone
 * even if the Chatyy servers are unreachable.
 *
 * Encryption model — identical KDF to e2ee_backup_escrow (services/e2e.js):
 *   • salt: 16 random bytes
 *   • iterated SHA-512 over UTF8(password) || salt, 100_000 iters → 32B key
 *   • body: nacl.secretbox(json, nonce, key) where nonce is 24 random bytes
 *
 * Layout on disk:
 *   [magic 4B 'CYB2'][salt 16B][nonce 24B][ciphertext+poly1305tag]
 *
 * The passphrase NEVER leaves the device. Chatyy servers receive only the
 * decrypted JSON (in `chat_restore_from_blob`) and they immediately re-insert
 * rows skipping duplicates by client_msg_id.
 */

import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import {
  encodeBase64,
  decodeBase64,
  encodeUTF8,
  decodeUTF8,
} from 'tweetnacl-util';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as api from './api';

// expo-document-picker / expo-auth-session / expo-background-fetch are only
// imported lazily inside the functions that need them so the engine can be
// required from web/test contexts without exploding when those native
// modules aren't linked.

// ─── Constants ───────────────────────────────────────────────────────────
const MAGIC = new Uint8Array([0x43, 0x59, 0x42, 0x32]); // 'CYB2'
const SALT_LEN = 16;
const NONCE_LEN = nacl.secretbox.nonceLength; // 24
const KDF_ITERS = 100_000;
const BUNDLE_VERSION = 2;

// Storage keys for SecureStore — stash last-used Drive fileId + refresh token
// so silent auto-backup doesn't need to prompt the user every time.
const SS_DRIVE_FILE_ID = 'chatyy_cloud_backup_drive_file_id';
const SS_DRIVE_ACCESS = 'chatyy_cloud_backup_drive_access_token';
const SS_DRIVE_ACCESS_EXP = 'chatyy_cloud_backup_drive_access_exp';
const SS_DRIVE_REFRESH = 'chatyy_cloud_backup_drive_refresh_token';
const SS_LAST_BACKUP_AT = 'chatyy_cloud_backup_last_at';
const SS_FREQ_KEY = 'chatyy_cloud_backup_frequency';        // 'off' | 'daily' | 'weekly' | 'monthly'
const SS_WIFI_ONLY = 'chatyy_cloud_backup_wifi_only';

const DRIVE_FILE_PREFIX = 'chatyy-backup-';
const DRIVE_FILE_SUFFIX = '.enc';
// Google Cloud OAuth client — provisioned in the Chatyy GCP project. The
// `drive.file` scope only sees files the app itself creates, so we don't
// need broader permission on the user's Drive.
const GOOGLE_OAUTH_CLIENT_IDS = {
  // Replace with real client IDs from console.cloud.google.com when shipping.
  ios: '782929446226-chatyy-ios.apps.googleusercontent.com',
  android: '782929446226-chatyy-android.apps.googleusercontent.com',
  web: '782929446226-chatyy-web.apps.googleusercontent.com',
};
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// ─── Key derivation (matches e2e.js buildKeyBackup KDF) ────────────────
function deriveKey(password, salt) {
  const pwBytes = decodeUTF8(password);
  const block = new Uint8Array(pwBytes.length + salt.length);
  block.set(pwBytes, 0);
  block.set(salt, pwBytes.length);
  let out = nacl.hash(block); // 64 bytes
  for (let i = 1; i < KDF_ITERS; i++) out = nacl.hash(out);
  return out.slice(0, 32);
}

// ─── Helpers ───────────────────────────────────────────────────────────
function _u8Concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function _u8ToBase64(u8) { return encodeBase64(u8); }
function _base64ToU8(b64) { return decodeBase64(b64); }

function _isoNow() { return new Date().toISOString(); }
function _safeTimestamp() {
  // 20260517T143012Z — filesystem-safe.
  return new Date().toISOString().replace(/[-:.]/g, '').replace(/\..*/, '') + 'Z';
}

// ─── 1. Export — pull all chat_messages, build the encrypted blob ──────
//
// Pulls every conversation the user is in via chatConversations(), then
// drains chat_messages page-by-page through chatMessages(). The output JSON
// is intentionally flat: { schema, conversations: [{id, name, type}, ...],
// messages: [{...}, ...] } so the restore endpoint can re-insert with a
// single bulk INSERT skipping duplicates by client_msg_id.
//
// passphrase: required (>=8 chars). Use the same one the user picked for
// e2ee_backup_escrow so they only memorize a single secret.
export async function exportChatBundle(passphrase, opts = {}) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase required (min 8 chars)');
  }

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // Conversation roster — used for restore so we can recreate threads that
  // were deleted on the server but the user wants back.
  onProgress({ stage: 'list_conversations' });
  const convResp = await api.chatConversations('', true);
  const conversations = Array.isArray(convResp?.conversations)
    ? convResp.conversations
    : Array.isArray(convResp)
      ? convResp
      : [];

  const messages = [];
  let lastTs = null;
  let convCount = 0;
  const pageSize = 200;

  for (const conv of conversations) {
    const cid = conv.id || conv.conversation_id;
    if (!cid) continue;
    convCount++;
    onProgress({ stage: 'drain_conv', conv_id: cid, conv_index: convCount, total_convs: conversations.length });

    // Paginate from newest → oldest via beforeId until empty page.
    let beforeId = null;
    let safety = 200; // hard cap 200 pages × 200 msgs = 40k per conv
    while (safety-- > 0) {
      let page;
      try {
        page = await api.chatMessages(cid, pageSize, beforeId, 0);
      } catch (e) {
        // Tolerant: skip the conversation rather than abort the whole backup.
        break;
      }
      const rows = Array.isArray(page?.messages)
        ? page.messages
        : Array.isArray(page)
          ? page
          : [];
      if (!rows.length) break;
      for (const m of rows) {
        // Trim to only the fields we need to faithfully restore. Heavy fields
        // (file_data inline base64) are intentionally dropped — file_url is
        // enough since media lives in R2.
        messages.push({
          id: m.id,
          conversation_id: cid,
          client_msg_id: m.client_msg_id || m.cmid || null,
          sender_email: m.sender_email || m.from || '',
          type: m.type || 'text',
          content: m.content ?? '',
          file_name: m.file_name || null,
          file_url: m.file_url || null,
          reply_to_id: m.reply_to_id || null,
          forwarded_from: m.forwarded_from || null,
          edited_at: m.edited_at || null,
          created_at: m.created_at,
          mentions: m.mentions || null,
        });
        if (!lastTs || (m.created_at && m.created_at > lastTs)) lastTs = m.created_at;
      }
      beforeId = rows[rows.length - 1].id;
      if (rows.length < pageSize) break;
    }
  }

  const manifest = {
    version: BUNDLE_VERSION,
    schema: 'chatyy.cloud.backup',
    created_at: _isoNow(),
    conv_count: conversations.length,
    msg_count: messages.length,
    last_msg_at: lastTs,
  };

  const bundle = {
    manifest,
    conversations: conversations.map((c) => ({
      id: c.id || c.conversation_id,
      name: c.name || null,
      type: c.type || 'direct',
      members: c.members || null,
    })),
    messages,
  };

  onProgress({ stage: 'encrypt' });

  // Encrypt: nacl.secretbox(decodeUTF8(JSON.stringify(bundle)), nonce, key)
  const plaintext = decodeUTF8(JSON.stringify(bundle));
  const salt = nacl.randomBytes(SALT_LEN);
  const nonce = nacl.randomBytes(NONCE_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = nacl.secretbox(plaintext, nonce, key);
  if (!cipher) throw new Error('encryption failed');

  // Layout: MAGIC | SALT | NONCE | CIPHERTEXT
  const encrypted = _u8Concat([MAGIC, salt, nonce, cipher]);

  onProgress({ stage: 'done', size_bytes: encrypted.length });

  return {
    encrypted,
    manifest,
    size_bytes: encrypted.length,
  };
}

// ─── 2. Decrypt (used by restore flow) ─────────────────────────────────
export function decryptChatBundle(encryptedU8, passphrase) {
  if (!(encryptedU8 instanceof Uint8Array)) throw new Error('encrypted must be Uint8Array');
  if (encryptedU8.length < MAGIC.length + SALT_LEN + NONCE_LEN + 16) {
    throw new Error('blob too short');
  }
  // Magic check
  for (let i = 0; i < MAGIC.length; i++) {
    if (encryptedU8[i] !== MAGIC[i]) throw new Error('bad magic — not a Chatyy backup blob');
  }
  const salt = encryptedU8.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = encryptedU8.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + NONCE_LEN);
  const cipher = encryptedU8.slice(MAGIC.length + SALT_LEN + NONCE_LEN);
  const key = deriveKey(passphrase, salt);
  const plain = nacl.secretbox.open(cipher, nonce, key);
  if (!plain) throw new Error('decryption failed — wrong passphrase or corrupted blob');
  let bundle;
  try { bundle = JSON.parse(encodeUTF8(plain)); } catch { throw new Error('decrypted payload is not JSON'); }
  if (!bundle?.manifest || !Array.isArray(bundle.messages)) {
    throw new Error('decrypted payload missing manifest/messages');
  }
  return bundle;
}

// ═════════════════════════════════════════════════════════════════════════
// iCloud Drive (iOS) — via expo-file-system documentDirectory.
// ═════════════════════════════════════════════════════════════════════════
//
// On iOS, when the app has the iCloud Documents capability + a
// `ubiquity-container-identifiers` entitlement, the app's
// `Documents/` folder (= FileSystem.documentDirectory) is mirrored into
// the user's iCloud Drive automatically by the OS. Writing a file there
// is enough; the user can browse it in Files.app → iCloud Drive → Chatyy.
//
// For read-back from a fresh install we use expo-document-picker (the user
// picks the file in iCloud Drive themselves), since we can't enumerate the
// ubiquity container from JS reliably.

export async function saveBundleToICloud(encryptedU8, opts = {}) {
  if (Platform.OS !== 'ios') throw new Error('iCloud is iOS-only');
  if (!FileSystem.documentDirectory) throw new Error('documentDirectory unavailable');
  const filename = (opts.filename || `${DRIVE_FILE_PREFIX}${_safeTimestamp()}${DRIVE_FILE_SUFFIX}`);
  const uri = FileSystem.documentDirectory + filename;
  await FileSystem.writeAsStringAsync(uri, _u8ToBase64(encryptedU8), {
    encoding: FileSystem.EncodingType.Base64,
  });
  // Best-effort: ask iOS to start the upload to iCloud Drive now. Expo SDK
  // doesn't expose NSFileManager.setUbiquitous so this just relies on the
  // background daemon, which usually kicks in within seconds.
  try { await SecureStore.setItemAsync(SS_LAST_BACKUP_AT, _isoNow()); } catch {}
  return { uri, filename, size_bytes: encryptedU8.length };
}

export async function pickBundleFromICloud() {
  // Lazy import so non-iOS bundlers don't choke.
  const DocumentPicker = await import('expo-document-picker');
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  const asset = res.assets[0];
  const b64 = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { encrypted: _base64ToU8(b64), filename: asset.name, size_bytes: asset.size || 0 };
}

// ═════════════════════════════════════════════════════════════════════════
// Google Drive (Android + iOS) — REST API v3.
// ═════════════════════════════════════════════════════════════════════════
//
// Auth: OAuth via expo-auth-session with the Google provider. Scope
// drive.file means the access token can ONLY see/upload files this app
// itself creates — no read on the user's other Drive content.
//
// Upload: multipart with metadata + binary in a single POST to
// https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart .
//
// List: GET https://www.googleapis.com/drive/v3/files?q=name+contains+...
// filtered to the chatyy-backup-*.enc prefix so the picker only sees our
// own files even with drive.file scope (which already enforces this).
// ─────────────────────────────────────────────────────────────────────────

function _googleClientId() {
  if (Platform.OS === 'ios') return GOOGLE_OAUTH_CLIENT_IDS.ios;
  if (Platform.OS === 'android') return GOOGLE_OAUTH_CLIENT_IDS.android;
  return GOOGLE_OAUTH_CLIENT_IDS.web;
}

async function _getCachedAccessToken() {
  try {
    const tok = await SecureStore.getItemAsync(SS_DRIVE_ACCESS);
    const exp = await SecureStore.getItemAsync(SS_DRIVE_ACCESS_EXP);
    if (tok && exp && Date.now() < parseInt(exp, 10) - 60_000) return tok;
  } catch {}
  return null;
}

async function _persistAccessToken(token, expiresInSec) {
  try {
    await SecureStore.setItemAsync(SS_DRIVE_ACCESS, token);
    await SecureStore.setItemAsync(
      SS_DRIVE_ACCESS_EXP,
      String(Date.now() + (expiresInSec || 3600) * 1000)
    );
  } catch {}
}

/**
 * Interactive sign-in for Google Drive. Returns access token. Must be
 * called from a UI context (user-initiated tap) — popping a browser is
 * not allowed from background tasks.
 */
export async function signInGoogleDrive() {
  const cached = await _getCachedAccessToken();
  if (cached) return cached;

  const AuthSession = await import('expo-auth-session');
  const Google = await import('expo-auth-session/providers/google');

  // expo-auth-session Google provider — handles iOS native + Android with
  // the standard PKCE flow. The native bridge needs the OAuth client IDs
  // we registered in app.json (see scheme below) so the redirect URI
  // matches what we put in Google Cloud Console.
  const discovery = {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  };

  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'com.onemundo.mail',
    path: 'oauthredirect',
  });

  const request = new AuthSession.AuthRequest({
    clientId: _googleClientId(),
    scopes: GOOGLE_SCOPES,
    redirectUri,
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
  });
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || !result.params?.code) {
    throw new Error('Google sign-in cancelled or failed');
  }

  const tokenResp = await AuthSession.exchangeCodeAsync(
    {
      clientId: _googleClientId(),
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    discovery,
  );
  if (!tokenResp.accessToken) throw new Error('Google token exchange failed');
  await _persistAccessToken(tokenResp.accessToken, tokenResp.expiresIn);
  if (tokenResp.refreshToken) {
    try { await SecureStore.setItemAsync(SS_DRIVE_REFRESH, tokenResp.refreshToken); } catch {}
  }
  return tokenResp.accessToken;
}

async function _ensureAccessToken() {
  const cached = await _getCachedAccessToken();
  if (cached) return cached;
  // Try to silently refresh
  let refreshToken = null;
  try { refreshToken = await SecureStore.getItemAsync(SS_DRIVE_REFRESH); } catch {}
  if (refreshToken) {
    try {
      const body = new URLSearchParams({
        client_id: _googleClientId(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString();
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await r.json();
      if (j.access_token) {
        await _persistAccessToken(j.access_token, j.expires_in);
        return j.access_token;
      }
    } catch {}
  }
  // Need interactive sign-in — caller must trigger from UI.
  const e = new Error('Google sign-in required');
  e.code = 'ERR_GOOGLE_SIGNIN';
  throw e;
}

/**
 * Upload an encrypted blob to Google Drive using multipart REST. Stores the
 * Drive fileId in SecureStore so subsequent backups can replace it (or the
 * user can locate it on a new device through `listGoogleDriveBackups`).
 */
export async function uploadBundleToGoogleDrive(encryptedU8, opts = {}) {
  const accessToken = await _ensureAccessToken();
  const filename = opts.filename || `${DRIVE_FILE_PREFIX}${_safeTimestamp()}${DRIVE_FILE_SUFFIX}`;

  // Build multipart body manually — RN fetch doesn't support FormData with
  // binary parts reliably enough on iOS, so we do it the legacy way:
  // --boundary
  // Content-Type: application/json; charset=UTF-8
  //
  // {metadata}
  // --boundary
  // Content-Type: application/octet-stream
  // Content-Transfer-Encoding: base64
  //
  // {base64-body}
  // --boundary--
  const boundary = `chatyy-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({
    name: filename,
    mimeType: 'application/octet-stream',
    description: 'Chatyy chat backup (encrypted)',
  });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${_u8ToBase64(encryptedU8)}\r\n` +
    `--${boundary}--`;

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Drive upload failed (${resp.status}): ${txt.slice(0, 200)}`);
  }
  const j = await resp.json();
  try { await SecureStore.setItemAsync(SS_DRIVE_FILE_ID, j.id || ''); } catch {}
  try { await SecureStore.setItemAsync(SS_LAST_BACKUP_AT, _isoNow()); } catch {}
  return {
    fileId: j.id,
    filename: j.name,
    size_bytes: encryptedU8.length,
    createdAt: j.createdTime || _isoNow(),
  };
}

/**
 * List up to `limit` of this app's backups on the user's Drive, newest
 * first. Drive scope `drive.file` already restricts results to files this
 * app created, but we add a name-prefix filter to be safe.
 */
export async function listGoogleDriveBackups(limit = 5) {
  const accessToken = await _ensureAccessToken();
  // Google Drive query language — name contains + sort by createdTime desc.
  const q = encodeURIComponent(`name contains '${DRIVE_FILE_PREFIX}' and trashed = false`);
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${q}` +
    `&orderBy=createdTime desc` +
    `&pageSize=${Math.max(1, Math.min(50, limit))}` +
    `&fields=files(id,name,size,createdTime)`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Drive list failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  return (j.files || []).map((f) => ({
    fileId: f.id,
    filename: f.name,
    size_bytes: parseInt(f.size || '0', 10),
    createdAt: f.createdTime,
  }));
}

/** Download a backup by Drive fileId and decrypt with passphrase. */
export async function downloadGoogleDriveBackup(fileId, passphrase) {
  const accessToken = await _ensureAccessToken();
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) throw new Error(`Drive download failed (${r.status})`);
  // Read as ArrayBuffer → Uint8Array. RN's fetch supports arrayBuffer() on
  // recent SDKs; fall back to blob → FileReader if not.
  let buf;
  try { buf = await r.arrayBuffer(); }
  catch {
    const blob = await r.blob();
    buf = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onloadend = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsArrayBuffer(blob);
    });
  }
  const encrypted = new Uint8Array(buf);
  return decryptChatBundle(encrypted, passphrase);
}

// ═════════════════════════════════════════════════════════════════════════
// 3. Restore — push the decrypted bundle to the backend.
// ═════════════════════════════════════════════════════════════════════════
//
// The backend endpoint chat_restore_from_blob accepts the manifest + the
// list of conversations + messages and performs a bulk INSERT skipping
// duplicates by client_msg_id (so a restore that overlaps with messages
// the user has received since the backup is idempotent).
//
// We chunk by 1000 messages per request to dodge PHP's post_max_size on
// large restores.

const RESTORE_CHUNK = 1000;

export async function restoreBundle(bundle, opts = {}) {
  if (!bundle?.manifest || !Array.isArray(bundle.messages)) {
    throw new Error('invalid bundle');
  }
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const total = bundle.messages.length;
  let inserted = 0;
  let skipped = 0;

  // First call: send manifest + conversations. Subsequent calls: just chunks.
  const firstResp = await api.apiCall(
    'chat_restore_from_blob',
    {
      manifest: bundle.manifest,
      conversations: bundle.conversations || [],
      messages: bundle.messages.slice(0, RESTORE_CHUNK),
      chunk_index: 0,
      total_chunks: Math.max(1, Math.ceil(total / RESTORE_CHUNK)),
    },
    'POST',
  );
  inserted += firstResp?.inserted || 0;
  skipped += firstResp?.skipped || 0;
  onProgress({ stage: 'restore', done: Math.min(RESTORE_CHUNK, total), total });

  for (let i = RESTORE_CHUNK; i < total; i += RESTORE_CHUNK) {
    const resp = await api.apiCall(
      'chat_restore_from_blob',
      {
        manifest: bundle.manifest,
        messages: bundle.messages.slice(i, i + RESTORE_CHUNK),
        chunk_index: Math.floor(i / RESTORE_CHUNK),
        total_chunks: Math.ceil(total / RESTORE_CHUNK),
      },
      'POST',
    );
    inserted += resp?.inserted || 0;
    skipped += resp?.skipped || 0;
    onProgress({ stage: 'restore', done: Math.min(i + RESTORE_CHUNK, total), total });
  }
  return { inserted, skipped, total };
}

// ═════════════════════════════════════════════════════════════════════════
// 4. Auto-backup schedule preferences + execution.
// ═════════════════════════════════════════════════════════════════════════

export const BACKUP_FREQUENCIES = ['off', 'daily', 'weekly', 'monthly'];

export async function getBackupFrequency() {
  try {
    const v = await SecureStore.getItemAsync(SS_FREQ_KEY);
    return BACKUP_FREQUENCIES.includes(v) ? v : 'off';
  } catch { return 'off'; }
}

export async function setBackupFrequency(freq) {
  if (!BACKUP_FREQUENCIES.includes(freq)) throw new Error(`invalid frequency: ${freq}`);
  try { await SecureStore.setItemAsync(SS_FREQ_KEY, freq); } catch {}
  // Reschedule the background task to honor the new cadence. The minimum
  // interval BackgroundFetch honors is 15min on iOS, ~15min on Android.
  await _rescheduleBackgroundTask(freq);
}

export async function getWifiOnly() {
  try {
    const v = await SecureStore.getItemAsync(SS_WIFI_ONLY);
    return v !== '0'; // default ON — protect mobile data
  } catch { return true; }
}

export async function setWifiOnly(wifiOnly) {
  try { await SecureStore.setItemAsync(SS_WIFI_ONLY, wifiOnly ? '1' : '0'); } catch {}
}

export async function getLastBackupAt() {
  try { return await SecureStore.getItemAsync(SS_LAST_BACKUP_AT); } catch { return null; }
}

function _intervalSecondsFor(freq) {
  switch (freq) {
    case 'daily':   return 24 * 60 * 60;
    case 'weekly':  return 7 * 24 * 60 * 60;
    case 'monthly': return 30 * 24 * 60 * 60;
    default:        return 0;
  }
}

const BG_TASK_NAME = 'chatyy-cloud-backup';

async function _rescheduleBackgroundTask(freq) {
  try {
    const BackgroundFetch = await import('expo-background-fetch');
    const TaskManager = await import('expo-task-manager');

    if (freq === 'off') {
      try { await BackgroundFetch.unregisterTaskAsync(BG_TASK_NAME); } catch {}
      return;
    }

    // Register task definition once. expo-task-manager dedupes by name.
    if (!TaskManager.isTaskDefined(BG_TASK_NAME)) {
      TaskManager.defineTask(BG_TASK_NAME, async () => {
        try {
          const passphrase = await SecureStore.getItemAsync('chatyy_cloud_backup_passphrase');
          if (!passphrase) return BackgroundFetch.BackgroundFetchResult.NoData;

          // Wifi-only respect.
          const wifiOnly = await getWifiOnly();
          if (wifiOnly) {
            try {
              const NetInfo = await import('@react-native-community/netinfo').catch(() => null);
              if (NetInfo) {
                const state = await NetInfo.default.fetch();
                if (state?.type !== 'wifi') {
                  return BackgroundFetch.BackgroundFetchResult.NoData;
                }
              }
            } catch {}
          }

          // Skip if a recent backup is on file — respect the cadence.
          const freqNow = await getBackupFrequency();
          const lastAt = await getLastBackupAt();
          const minInterval = _intervalSecondsFor(freqNow) * 1000;
          if (lastAt && Date.now() - new Date(lastAt).getTime() < minInterval - 30 * 60 * 1000) {
            return BackgroundFetch.BackgroundFetchResult.NoData;
          }

          const { encrypted } = await exportChatBundle(passphrase);
          if (Platform.OS === 'ios') {
            await saveBundleToICloud(encrypted);
            // Also push to Drive if the user is signed in (silent path).
            try { await uploadBundleToGoogleDrive(encrypted); } catch {}
          } else {
            await uploadBundleToGoogleDrive(encrypted);
          }
          return BackgroundFetch.BackgroundFetchResult.NewData;
        } catch (e) {
          return BackgroundFetch.BackgroundFetchResult.Failed;
        }
      });
    }

    await BackgroundFetch.registerTaskAsync(BG_TASK_NAME, {
      minimumInterval: Math.max(15 * 60, Math.floor(_intervalSecondsFor(freq) / 4)),
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch {
    // expo-background-fetch isn't linked in dev — silently skip.
  }
}

/**
 * Cache the passphrase in SecureStore so the background task can run
 * without prompting. The user can clear it via `forgetPassphrase()`.
 *
 * Caveat: this trades a slice of E2EE-strictness for usability — the
 * passphrase now lives in the iOS Keychain / Android Keystore. That's
 * still strictly better than sending the unencrypted backup off-device.
 */
export async function rememberPassphrase(passphrase) {
  if (!passphrase) return;
  try { await SecureStore.setItemAsync('chatyy_cloud_backup_passphrase', passphrase); } catch {}
}
export async function forgetPassphrase() {
  try { await SecureStore.deleteItemAsync('chatyy_cloud_backup_passphrase'); } catch {}
}

// ═════════════════════════════════════════════════════════════════════════
// 5. High-level helpers used by the UI.
// ═════════════════════════════════════════════════════════════════════════

/**
 * One-shot "Salvar no iCloud". Builds the encrypted bundle and writes it
 * to the iCloud-backed documents folder. iOS will upload to the user's
 * iCloud Drive in the background.
 */
export async function backupToICloudNow(passphrase, opts = {}) {
  const { encrypted, manifest, size_bytes } = await exportChatBundle(passphrase, opts);
  const r = await saveBundleToICloud(encrypted);
  if (opts.rememberPassphrase) await rememberPassphrase(passphrase);
  return { ...r, manifest, size_bytes };
}

/** One-shot "Salvar no Google Drive". */
export async function backupToGoogleDriveNow(passphrase, opts = {}) {
  const { encrypted, manifest, size_bytes } = await exportChatBundle(passphrase, opts);
  const r = await uploadBundleToGoogleDrive(encrypted);
  if (opts.rememberPassphrase) await rememberPassphrase(passphrase);
  return { ...r, manifest, size_bytes };
}

/**
 * Pretty-format a manifest into the WhatsApp-style confirmation string:
 * "Encontrado backup de DD/MM com N conversas e M mensagens."
 */
export function formatManifestSummary(manifest, t) {
  try {
    const d = manifest?.last_msg_at ? new Date(manifest.last_msg_at) : new Date(manifest?.created_at);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const n = manifest?.conv_count || 0;
    const m = manifest?.msg_count || 0;
    if (typeof t === 'function') {
      const template = t('backup.cloud.foundSummary') ||
        'Encontrado backup de {date} com {conv} conversas e {msg} mensagens.';
      return template
        .replace('{date}', `${dd}/${mm}`)
        .replace('{conv}', n)
        .replace('{msg}', m);
    }
    return `Encontrado backup de ${dd}/${mm} com ${n} conversas e ${m} mensagens.`;
  } catch {
    return '';
  }
}
