// [2026-10-09 passkeys] "Entrar com passkey" (Face ID / Touch ID / digital).
//
// Backend: /api/passkeys.php on the US master (rpId chatyy.com.br — the
// ceremony must hit https://chatyy.com.br, never a regional edge host).
//
// Platform authenticator:
//   - native: the Expo module `react-native-passkeys` (native name
//     "ReactNativePasskeys"). NOT in the current binary — it is loaded with
//     requireOptionalNativeModule AT CALL TIME, never via the package's JS entry
//     (that one calls requireNativeModule at import → fatal on Android when the
//     native side is missing). Next build: `npx expo install react-native-passkeys`
//     + the Associated Domains entitlement (webcredentials:chatyy.com.br) and
//     assetlinks.json get_login_creds.
//   - web: navigator.credentials (WebAuthn) on https://chatyy.com.br.
//
// Everything stays behind PASSKEYS_ENABLED (constants/featureFlags.js) in the UI.
import { Platform } from 'react-native';
import * as api from './api';

const PK_BASE = 'https://chatyy.com.br';

let _native;
function nativePasskeys() {
  if (Platform.OS === 'web') return null;
  if (_native !== undefined) return _native;
  _native = null;
  try {
    // eslint-disable-next-line global-require
    const expo = require('expo');
    const m = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ReactNativePasskeys')
      : null;
    if (m && typeof m.create === 'function' && typeof m.get === 'function') _native = m;
  } catch { _native = null; }
  return _native;
}

// ── base64url <-> ArrayBuffer (web only) ───────────────────────────────────
function _b64uToBuf(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function _bufToB64u(buf) {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _webAvailable() {
  try {
    return Platform.OS === 'web' && typeof window !== 'undefined'
      && !!window.PublicKeyCredential && !!navigator?.credentials?.create
      && /(^|\.)chatyy\.com\.br$/.test(String(window.location?.hostname || ''));
  } catch { return false; }
}

/** true when this device can create/use a passkey right now (binary + OS). */
export function isPasskeySupported() {
  if (Platform.OS === 'web') return _webAvailable();
  const m = nativePasskeys();
  if (!m) return false;
  try { return typeof m.isSupported === 'function' ? !!m.isSupported() : true; } catch { return false; }
}

async function _platformCreate(options) {
  if (Platform.OS === 'web') {
    const pk = {
      ...options,
      challenge: _b64uToBuf(options.challenge),
      user: { ...options.user, id: _b64uToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: _b64uToBuf(c.id) })),
    };
    const cred = await navigator.credentials.create({ publicKey: pk });
    if (!cred) return null;
    return {
      id: cred.id,
      rawId: _bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: _bufToB64u(cred.response.clientDataJSON),
        attestationObject: _bufToB64u(cred.response.attestationObject),
        transports: typeof cred.response.getTransports === 'function' ? cred.response.getTransports() : [],
      },
    };
  }
  const m = nativePasskeys();
  if (!m) throw Object.assign(new Error('passkey_unavailable'), { code: 'unavailable' });
  return m.create(options);
}

async function _platformGet(options) {
  if (Platform.OS === 'web') {
    const pk = {
      ...options,
      challenge: _b64uToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: _b64uToBuf(c.id) })),
    };
    delete pk.has_passkeys;
    const cred = await navigator.credentials.get({ publicKey: pk });
    if (!cred) return null;
    return {
      id: cred.id,
      rawId: _bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: _bufToB64u(cred.response.clientDataJSON),
        authenticatorData: _bufToB64u(cred.response.authenticatorData),
        signature: _bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? _bufToB64u(cred.response.userHandle) : '',
      },
    };
  }
  const m = nativePasskeys();
  if (!m) throw Object.assign(new Error('passkey_unavailable'), { code: 'unavailable' });
  const { has_passkeys, ...req } = options || {}; // eslint-disable-line no-unused-vars
  return m.get(req);
}

async function _pk(action, body, withAuth) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const tok = api.getAuthToken?.();
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  const res = await fetch(`${PK_BASE}/api/passkeys.php?action=${encodeURIComponent(action)}`, {
    method: action === 'passkey_list' ? 'GET' : 'POST',
    headers,
    credentials: Platform.OS === 'web' ? 'include' : undefined,
    body: action === 'passkey_list' ? undefined : JSON.stringify(body || {}),
  });
  let j = null;
  try { j = await res.json(); } catch { j = null; }
  if (!j) return { success: false, status: res.status, message: '' };
  return { ...j, status: res.status };
}

function _isCancel(e) {
  const s = `${e?.name || ''} ${e?.code || ''} ${e?.message || ''}`;
  return /cancel|abort|NotAllowed|UserCancel|1001/i.test(s);
}

/**
 * Register a passkey for the signed-in account.
 * @returns {{ok:true, credentialId:string} | {ok:false, reason:'unavailable'|'cancelled'|'exists'|'auth'|'error', message?:string}}
 */
export async function registerPasskey(deviceName) {
  if (!isPasskeySupported()) return { ok: false, reason: 'unavailable' };
  try {
    const begin = await _pk('passkey_register_begin', {}, true);
    if (!begin?.success || !begin?.data?.challenge) {
      return { ok: false, reason: begin?.status === 401 ? 'auth' : 'error', message: begin?.message || '' };
    }
    const cred = await _platformCreate(begin.data);
    if (!cred) return { ok: false, reason: 'cancelled' };
    const finish = await _pk('passkey_register_finish', {
      id: cred.id,
      response: cred.response,
      device_name: String(deviceName || '').slice(0, 100),
    }, true);
    if (finish?.success) return { ok: true, credentialId: finish.data?.credential_id || cred.id };
    return { ok: false, reason: finish?.status === 409 ? 'exists' : 'error', message: finish?.message || '' };
  } catch (e) {
    return { ok: false, reason: _isCancel(e) ? 'cancelled' : 'error', message: String(e?.message || '') };
  }
}

/**
 * Sign in with a passkey. email optional: empty = the system sheet lists the
 * passkeys saved for chatyy.com.br on this device (usernameless).
 * @returns {{ok:true, token:string, email:string} | {ok:false, reason:'unavailable'|'cancelled'|'none'|'error', message?:string}}
 */
export async function loginWithPasskey(email) {
  if (!isPasskeySupported()) return { ok: false, reason: 'unavailable' };
  try {
    const begin = await _pk('passkey_login_begin', email ? { email } : {}, false);
    if (!begin?.success || !begin?.data?.challenge) return { ok: false, reason: 'error', message: begin?.message || '' };
    if (email && !begin.data.has_passkeys) return { ok: false, reason: 'none' };
    const assertion = await _platformGet(begin.data);
    if (!assertion) return { ok: false, reason: 'cancelled' };
    const finish = await _pk('passkey_login_finish', {
      email: email || '',
      id: assertion.id,
      response: assertion.response,
    }, false);
    if (finish?.success && finish?.data?.token) {
      return { ok: true, token: finish.data.token, email: finish.data.email || email || '' };
    }
    return { ok: false, reason: 'error', message: finish?.message || '' };
  } catch (e) {
    return { ok: false, reason: _isCancel(e) ? 'cancelled' : 'error', message: String(e?.message || '') };
  }
}

/** Passkeys registered on the signed-in account (any device). */
export async function listPasskeys() {
  try {
    const r = await _pk('passkey_list', null, true);
    return r?.success ? (r.data?.passkeys || []) : [];
  } catch { return []; }
}

export async function deletePasskey(credentialId) {
  try {
    const r = await _pk('passkey_delete', { credential_id: credentialId }, true);
    return !!r?.success;
  } catch { return false; }
}
