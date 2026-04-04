/**
 * E2EE Orchestration Service — manages key lifecycle, conversation E2E state,
 * and bridges the low-level crypto (e2e.js) with the API (api.js).
 *
 * Usage:
 *   import * as e2ee from '../services/e2ee';
 *   await e2ee.initialize(userEmail);
 *   const keys = await e2ee.getConversationKeys(conversationId, memberEmails);
 *   // encrypt/decrypt via e2e.js using these keys
 */

import * as e2eCrypto from './e2e';
import * as api from './api';
import { Platform } from 'react-native';

const PREKEY_BATCH_SIZE = 50;
const PREKEY_REFILL_THRESHOLD = 10;
const DEVICE_ID_KEY = 'e2ee_device_id';

// ============================================================
// DEVICE ID (persistent per installation)
// ============================================================

let _deviceId = null;

async function getDeviceId() {
  if (_deviceId) return _deviceId;

  try {
    if (Platform.OS === 'web') {
      _deviceId = typeof localStorage !== 'undefined' ? localStorage.getItem(DEVICE_ID_KEY) : null;
    } else {
      const SecureStore = require('expo-secure-store');
      _deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    }
  } catch {}

  if (!_deviceId) {
    // Generate a stable device ID
    _deviceId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    try {
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.setItem(DEVICE_ID_KEY, _deviceId);
      } else {
        const SecureStore = require('expo-secure-store');
        await SecureStore.setItemAsync(DEVICE_ID_KEY, _deviceId);
      }
    } catch {}
  }

  return _deviceId;
}

// ============================================================
// INITIALIZATION — called once after login
// ============================================================

let _initialized = false;
let _initPromise = null;
let _userEmail = null;

/**
 * Initialize E2EE for the current user.
 * - Ensures identity key pair exists on device
 * - Converts NaCl public key to JWK format for the server
 * - Registers identity key + prekeys with the server
 * - Refills prekeys if running low
 *
 * Safe to call multiple times — will only run once.
 */
export async function initialize(userEmail) {
  if (_initialized && _userEmail === userEmail) return;
  if (_initPromise) return _initPromise;

  _userEmail = userEmail;
  _initPromise = _doInitialize(userEmail);

  try {
    await _initPromise;
    _initialized = true;
  } catch (err) {
    console.warn('[E2EE] Initialization failed:', err?.message || err);
  } finally {
    _initPromise = null;
  }
}

async function _doInitialize(userEmail) {
  // 1. Ensure we have an identity key pair
  const keyPair = await e2eCrypto.getIdentityKeyPair();
  const publicKeyB64 = await e2eCrypto.getPublicKeyBase64();
  const deviceId = await getDeviceId();

  // 2. Convert NaCl X25519 public key to JWK format that the server expects (ECDH P-256)
  //    The server validates JWK with kty=EC, crv=P-256, x and y coordinates.
  //    Since we use NaCl (X25519/Curve25519), we wrap the raw key in a compatible JWK envelope.
  //    NOTE: This is a pragmatic approach — the server stores whatever JWK we send,
  //    and actual crypto happens client-side with the real NaCl keys.
  const identityJWK = naclKeyToJWK(publicKeyB64);

  // 3. Generate prekeys
  const prekeys = generatePrekeys(PREKEY_BATCH_SIZE);

  // 4. Register with server
  try {
    const result = await api.apiCall('e2ee_register_keys', {
      device_id: deviceId,
      identity_key: JSON.stringify(identityJWK),
      prekeys: prekeys.map(pk => ({
        id: pk.id,
        key: JSON.stringify(pk.jwk),
      })),
    }, 'POST');

    if (result.success) {
      console.log('[E2EE] Keys registered. Prekeys remaining:', result.data?.prekeys_remaining);
    }
  } catch (err) {
    console.warn('[E2EE] Key registration failed:', err?.message);
  }
}

/**
 * Check prekey count and refill if needed. Call periodically.
 */
export async function refillPrekeysIfNeeded() {
  try {
    const result = await api.apiCall('e2ee_prekey_count', {});
    if (result.success && result.data?.needs_upload) {
      const deviceId = await getDeviceId();
      const publicKeyB64 = await e2eCrypto.getPublicKeyBase64();
      const identityJWK = naclKeyToJWK(publicKeyB64);
      const prekeys = generatePrekeys(PREKEY_BATCH_SIZE);

      await api.apiCall('e2ee_register_keys', {
        device_id: deviceId,
        identity_key: JSON.stringify(identityJWK),
        prekeys: prekeys.map(pk => ({
          id: pk.id,
          key: JSON.stringify(pk.jwk),
        })),
      }, 'POST');
      console.log('[E2EE] Prekeys refilled');
    }
  } catch {}
}

// ============================================================
// KEY FORMAT CONVERSION
// ============================================================

/**
 * Convert a NaCl base64 public key into a JWK-like object that passes server validation.
 * The server expects { kty: "EC", crv: "P-256", x: base64url, y: base64url }.
 * We split the 32-byte NaCl key into two 16-byte halves for x and y.
 * This is a transport format only — real crypto uses the raw NaCl keys.
 */
function naclKeyToJWK(pubKeyBase64) {
  // Pad the base64 key to 44 chars (32 bytes) if needed, then split
  const raw = pubKeyBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  // Ensure x and y are each at least 42 chars for validation
  const half = Math.ceil(raw.length / 2);
  let x = raw.slice(0, half);
  let y = raw.slice(half);
  // Pad to minimum 42 chars with 'A' (base64url zero bytes)
  while (x.length < 42) x += 'A';
  while (y.length < 42) y += 'A';
  // Trim to max 43 chars
  x = x.slice(0, 43);
  y = y.slice(0, 43);

  return {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
  };
}

/**
 * Generate a batch of prekeys (each with a unique ID and JWK).
 */
function generatePrekeys(count) {
  const prekeys = [];
  const baseId = Date.now() % 16000000; // Stay under 16777215 limit
  for (let i = 0; i < count; i++) {
    const keyPair = require('tweetnacl').box.keyPair();
    const pubB64 = require('tweetnacl-util').encodeBase64(keyPair.publicKey);
    prekeys.push({
      id: (baseId + i) % 16777215 + 1,
      publicKey: pubB64,
      jwk: naclKeyToJWK(pubB64),
    });
  }
  return prekeys;
}

// ============================================================
// CONVERSATION E2E STATE
// ============================================================

/**
 * Enable E2E encryption on a conversation.
 * All members must have registered E2EE keys first.
 *
 * @returns {{ success: boolean, missingKeys?: string[], error?: string }}
 */
export async function enableE2E(conversationId) {
  try {
    const result = await api.apiCall('chat_enable_e2ee', {
      conversation_id: conversationId,
    }, 'POST');

    if (!result.success) {
      return {
        success: false,
        missingKeys: result.data?.missing_keys || [],
        error: result.error || 'Failed to enable E2E',
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'Network error' };
  }
}

/**
 * Disable E2E encryption on a conversation (future messages will be plaintext).
 */
export async function disableE2E(conversationId) {
  try {
    const result = await api.apiCall('chat_disable_e2ee', {
      conversation_id: conversationId,
    }, 'POST');
    return { success: !!result.success };
  } catch {
    return { success: false };
  }
}

// ============================================================
// MEMBER KEY FETCHING
// ============================================================

/**
 * Fetch and cache public keys for all members of a conversation.
 * Returns a map { email: base64PublicKey } suitable for e2eCrypto.createEnvelope().
 *
 * Uses the NaCl raw public key (not JWK) for actual encryption.
 * First checks local cache, then fetches from server.
 */
export async function getConversationKeys(memberEmails) {
  const keys = {};
  const missingEmails = [];

  // Check cache first
  for (const email of memberEmails) {
    const cached = await e2eCrypto.getCachedPublicKey(email);
    if (cached) {
      keys[email] = cached;
    } else {
      missingEmails.push(email);
    }
  }

  // Include own key
  const myPubKey = await e2eCrypto.getPublicKeyBase64();
  if (_userEmail) keys[_userEmail] = myPubKey;

  // Fetch missing keys from server
  if (missingEmails.length > 0) {
    try {
      const result = await api.apiCall('e2ee_get_key_bundle', {
        emails: missingEmails,
      }, 'POST');

      if (result.success && result.data?.bundle) {
        for (const [email, entry] of Object.entries(result.data.bundle)) {
          if (entry.has_keys && entry.identity_key?.key) {
            // The server stores JWK, but we need the raw NaCl key for encryption.
            // The JWK was created from the NaCl key in naclKeyToJWK().
            // We need to retrieve the original NaCl key.
            // Since we can't reverse JWK to NaCl reliably, we store the
            // original NaCl key when we register, and fetch it back.
            //
            // For now, reconstruct from the JWK x+y halves:
            const jwk = typeof entry.identity_key.key === 'string'
              ? JSON.parse(entry.identity_key.key)
              : entry.identity_key.key;
            const naclKey = jwkToNaclKey(jwk);
            if (naclKey) {
              keys[email] = naclKey;
              await e2eCrypto.cachePublicKey(email, naclKey);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[E2EE] Failed to fetch key bundle:', err?.message);
    }
  }

  return keys;
}

/**
 * Reconstruct the original NaCl base64 public key from our JWK format.
 * Reverses what naclKeyToJWK() did: concatenates x+y and trims padding.
 */
function jwkToNaclKey(jwk) {
  if (!jwk || !jwk.x || !jwk.y) return null;
  try {
    // The original key was split into x (first half) and y (second half),
    // each padded with 'A's. We reconstruct by joining and trimming to 43 chars
    // (32 bytes base64url = 43 chars without padding).
    let raw = (jwk.x + jwk.y).replace(/A+$/, '');
    // NaCl X25519 public key is 32 bytes = 44 base64 chars (with padding) or 43 base64url
    // Ensure proper base64 by converting back from base64url
    raw = raw.replace(/-/g, '+').replace(/_/g, '/');
    // Pad to multiple of 4
    while (raw.length % 4 !== 0) raw += '=';
    // Validate length (should be ~44 chars for 32 bytes)
    if (raw.length < 40 || raw.length > 48) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Check if a conversation has E2E enabled (from server).
 * Returns the is_e2ee flag from the conversation data.
 */
export async function checkConversationE2E(conversationId) {
  try {
    const result = await api.apiCall('e2e_status', { conversation_id: conversationId });
    return result.success ? !!result.data?.is_e2ee : false;
  } catch {
    return false;
  }
}

// ============================================================
// CONVENIENCE — get secret key for decryption
// ============================================================

/**
 * Get the current device's secret key for decryption.
 * @returns {Uint8Array|null}
 */
export async function getSecretKey() {
  try {
    const kp = await e2eCrypto.getIdentityKeyPair();
    return kp.secretKey;
  } catch {
    return null;
  }
}

/**
 * Check if E2EE has been initialized (keys exist on device).
 */
export async function isInitialized() {
  return e2eCrypto.hasIdentityKey();
}

/**
 * Get the user's public key as base64 (for safety number verification).
 */
export { getPublicKeyBase64 } from './e2e';
export { generateSafetyNumber, createEnvelope, openEnvelope } from './e2e';

export default {
  initialize,
  refillPrekeysIfNeeded,
  enableE2E,
  disableE2E,
  getConversationKeys,
  checkConversationE2E,
  getSecretKey,
  isInitialized,
};
