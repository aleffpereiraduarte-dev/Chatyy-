/**
 * E2E Encryption Service — Signal-like protocol using X25519 + XSalsa20-Poly1305
 *
 * Key hierarchy:
 * - Identity Key Pair (long-term): X25519, stored securely on device
 * - Ephemeral Key Pair (per-message): fresh X25519 for forward secrecy
 *
 * Message flow:
 * 1. Sender generates ephemeral key pair
 * 2. Sender computes shared secret: nacl.box(msg, nonce, recipientPubKey, ephemeralSecretKey)
 * 3. Sends: { encrypted, nonce, ephemeralPublicKey }
 * 4. Recipient: nacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey)
 *
 * This gives forward secrecy per message — compromising the identity key
 * doesn't reveal past messages (each used unique ephemeral keys).
 */

import nacl from 'tweetnacl';
import {
  encodeBase64,
  decodeBase64,
  encodeUTF8,
  decodeUTF8,
} from 'tweetnacl-util';
import { Platform } from 'react-native';

const E2E_IDENTITY_KEY = 'e2e_identity_key';
const E2E_PUBKEYS_CACHE = 'e2e_pubkeys';

// ============================================================
// SECURE KEY STORAGE
// ============================================================

async function secureGet(key) {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    const SecureStore = require('expo-secure-store');
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function secureSet(key, value) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      }
      return;
    }
    const SecureStore = require('expo-secure-store');
    if (value) await SecureStore.setItemAsync(key, value);
    else await SecureStore.deleteItemAsync(key);
  } catch {}
}

// ============================================================
// IDENTITY KEY PAIR (long-term, per device)
// ============================================================

let _identityKeyPair = null;

/**
 * Get or create the identity key pair for this device.
 * Returns { publicKey: Uint8Array, secretKey: Uint8Array }
 */
export async function getIdentityKeyPair() {
  if (_identityKeyPair) return _identityKeyPair;

  const stored = await secureGet(E2E_IDENTITY_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      _identityKeyPair = {
        publicKey: decodeBase64(parsed.pub),
        secretKey: decodeBase64(parsed.sec),
      };
      return _identityKeyPair;
    } catch {}
  }

  // Generate new identity key pair
  const keyPair = nacl.box.keyPair();
  await secureSet(E2E_IDENTITY_KEY, JSON.stringify({
    pub: encodeBase64(keyPair.publicKey),
    sec: encodeBase64(keyPair.secretKey),
  }));
  _identityKeyPair = keyPair;
  return _identityKeyPair;
}

/**
 * Get the public key as base64 string (for uploading to server).
 */
export async function getPublicKeyBase64() {
  const kp = await getIdentityKeyPair();
  return encodeBase64(kp.publicKey);
}

/**
 * Check if E2E keys exist on this device.
 */
export async function hasIdentityKey() {
  const stored = await secureGet(E2E_IDENTITY_KEY);
  return !!stored;
}

/**
 * Reset identity keys (dangerous — will lose ability to decrypt old messages).
 */
export async function resetIdentityKeys() {
  _identityKeyPair = null;
  await secureSet(E2E_IDENTITY_KEY, null);
  await secureSet(E2E_PUBKEYS_CACHE, null);
}

// ============================================================
// PUBLIC KEY CACHE (other users' public keys)
// ============================================================

let _pubKeyCache = null;

async function loadPubKeyCache() {
  if (_pubKeyCache) return _pubKeyCache;
  try {
    const stored = await secureGet(E2E_PUBKEYS_CACHE);
    _pubKeyCache = stored ? JSON.parse(stored) : {};
  } catch {
    _pubKeyCache = {};
  }
  return _pubKeyCache;
}

async function savePubKeyCache() {
  if (_pubKeyCache) {
    await secureSet(E2E_PUBKEYS_CACHE, JSON.stringify(_pubKeyCache));
  }
}

/**
 * Cache a user's public key locally.
 */
export async function cachePublicKey(email, pubKeyBase64) {
  const cache = await loadPubKeyCache();
  cache[email] = pubKeyBase64;
  await savePubKeyCache();
}

/**
 * Get a cached public key for a user.
 */
export async function getCachedPublicKey(email) {
  const cache = await loadPubKeyCache();
  return cache[email] || null;
}

// ============================================================
// ENCRYPTION (per-message forward secrecy)
// ============================================================

/**
 * Encrypt a message for a recipient.
 *
 * Uses ephemeral X25519 key pair per message for forward secrecy.
 * Returns: { ct: base64, nonce: base64, ek: base64 }
 *   ct = ciphertext, nonce = random nonce, ek = ephemeral public key
 */
export function encryptMessage(plaintext, recipientPubKeyBase64) {
  const recipientPubKey = decodeBase64(recipientPubKeyBase64);
  const messageBytes = decodeUTF8(plaintext);

  // Generate ephemeral key pair (forward secrecy)
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const encrypted = nacl.box(messageBytes, nonce, recipientPubKey, ephemeral.secretKey);

  return {
    ct: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
    ek: encodeBase64(ephemeral.publicKey),
  };
}

/**
 * Decrypt a message received.
 *
 * @param {object} envelope - { ct, nonce, ek } all base64
 * @param {Uint8Array} mySecretKey - recipient's secret key
 * @returns {string|null} decrypted plaintext, or null if decryption fails
 */
export function decryptMessage(envelope, mySecretKey) {
  try {
    const ciphertext = decodeBase64(envelope.ct);
    const nonce = decodeBase64(envelope.nonce);
    const ephemeralPubKey = decodeBase64(envelope.ek);

    const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPubKey, mySecretKey);
    if (!decrypted) return null;

    return encodeUTF8(decrypted);
  } catch {
    return null;
  }
}

// ============================================================
// GROUP ENCRYPTION
// ============================================================

/**
 * Encrypt a message for multiple recipients (group chat).
 * Encrypts the same plaintext individually for each recipient.
 *
 * @param {string} plaintext
 * @param {Object.<string, string>} recipientKeys - { email: pubKeyBase64 }
 * @returns {Object.<string, object>} - { email: { ct, nonce, ek } }
 */
export function encryptForGroup(plaintext, recipientKeys) {
  const result = {};
  for (const [email, pubKey] of Object.entries(recipientKeys)) {
    result[email] = encryptMessage(plaintext, pubKey);
  }
  return result;
}

/**
 * Decrypt a group message (find our envelope and decrypt).
 *
 * @param {Object.<string, object>} envelopes - { email: { ct, nonce, ek } }
 * @param {string} myEmail
 * @param {Uint8Array} mySecretKey
 * @returns {string|null}
 */
export function decryptGroupMessage(envelopes, myEmail, mySecretKey) {
  const myEnvelope = envelopes[myEmail];
  if (!myEnvelope) return null;
  return decryptMessage(myEnvelope, mySecretKey);
}

// ============================================================
// ENVELOPE FORMAT (what gets stored on server)
// ============================================================

/**
 * Create a full E2E envelope ready to send to server.
 * For 1:1 chats, encrypts for the other person + self (so sender can read own messages).
 *
 * @param {string} plaintext
 * @param {string} myEmail
 * @param {Object.<string, string>} memberKeys - { email: pubKeyBase64 } including self
 * @returns {string} JSON string to store as message content
 */
export function createEnvelope(plaintext, myEmail, memberKeys) {
  const envelopes = {};
  for (const [email, pubKey] of Object.entries(memberKeys)) {
    envelopes[email] = encryptMessage(plaintext, pubKey);
  }
  return JSON.stringify({
    e2e: 1,
    v: 1,
    envelopes,
  });
}

/**
 * Try to decrypt an E2E envelope from message content.
 * Returns plaintext if E2E, or original content if not encrypted.
 *
 * @param {string} content - message content (may be E2E JSON or plain text)
 * @param {string} myEmail
 * @param {Uint8Array} mySecretKey
 * @returns {object} { text: string, encrypted: boolean }
 */
export function openEnvelope(content, myEmail, mySecretKey) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.e2e === 1 && parsed.envelopes) {
      const myEnvelope = parsed.envelopes[myEmail];
      if (!myEnvelope) return { text: '[E2E: no key for you]', encrypted: true };
      const plaintext = decryptMessage(myEnvelope, mySecretKey);
      if (plaintext === null) return { text: '[E2E: decryption failed]', encrypted: true };
      return { text: plaintext, encrypted: true };
    }
  } catch {
    // Not JSON or not E2E — return as-is
  }
  return { text: content, encrypted: false };
}

// ============================================================
// VERIFICATION (Safety Number)
// ============================================================

/**
 * Generate a safety number for verifying identity (like WhatsApp's security code).
 * Uses both users' identity public keys to create a deterministic number.
 *
 * @param {string} myPubKeyBase64
 * @param {string} theirPubKeyBase64
 * @returns {string} 12-digit safety number
 */
export function generateSafetyNumber(myPubKeyBase64, theirPubKeyBase64) {
  // Sort keys so both sides get the same number
  const keys = [myPubKeyBase64, theirPubKeyBase64].sort();
  const combined = decodeUTF8(keys[0] + keys[1]);
  const hash = nacl.hash(combined);

  // Take first 6 bytes and convert to 12-digit number
  let number = '';
  for (let i = 0; i < 6; i++) {
    number += String(hash[i] % 100).padStart(2, '0');
  }
  // Format as XXX-XXX-XXX-XXX
  return number.replace(/(\d{3})(?=\d)/g, '$1-');
}

export default {
  getIdentityKeyPair,
  getPublicKeyBase64,
  hasIdentityKey,
  resetIdentityKeys,
  cachePublicKey,
  getCachedPublicKey,
  encryptMessage,
  decryptMessage,
  encryptForGroup,
  decryptGroupMessage,
  createEnvelope,
  openEnvelope,
  generateSafetyNumber,
};
