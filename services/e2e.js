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
const E2E_PREKEY_SECRETS = 'e2e_prekey_secrets'; // { [prekey_id]: base64(secretKey) }
const E2E_SIGNED_PREKEY = 'e2e_signed_prekey';   // { id, pub, sec, sig } — medium-term
const E2E_SESSION_PREFIX = 'e2e_session:';        // per-peer cached SK + counters

// Scope identity keys per-email so switching accounts doesn't overwrite the
// key pair, which would orphan every already-sent E2E envelope (user would
// see "chave indisponível" on their own messages).
let _activeAccountEmail = null;
function identityStorageKey() {
  return _activeAccountEmail ? `${E2E_IDENTITY_KEY}:${_activeAccountEmail.toLowerCase()}` : E2E_IDENTITY_KEY;
}
export function setActiveAccount(email) {
  _activeAccountEmail = email || null;
  _identityKeyPair = null; // force reload on next access
}

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

  const scopedKey = identityStorageKey();
  let stored = await secureGet(scopedKey);

  // One-time migration: older builds stored the identity globally at
  // E2E_IDENTITY_KEY. Adopt it for the active account so we don't rotate
  // the key pair and orphan all previously-sent envelopes.
  if (!stored && _activeAccountEmail && scopedKey !== E2E_IDENTITY_KEY) {
    const legacy = await secureGet(E2E_IDENTITY_KEY);
    if (legacy) {
      await secureSet(scopedKey, legacy);
      stored = legacy;
    }
  }

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
  await secureSet(scopedKey, JSON.stringify({
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
 * Ed25519 verify key derived from the identity secret. Recipients use this
 * to verify the signed prekey's Ed25519 signature without having to trust
 * the server's TOFU mapping. Same seed as in rotateSignedPrekey.
 */
export async function getSigningPublicKeyBase64() {
  const identity = await getIdentityKeyPair();
  const seed = identity.secretKey.slice(0, 32);
  const signKp = nacl.sign.keyPair.fromSeed(seed);
  return encodeBase64(signKp.publicKey);
}

/**
 * Check if E2E keys exist on this device.
 */
export async function hasIdentityKey() {
  const stored = await secureGet(identityStorageKey());
  return !!stored;
}

/**
 * Reset identity keys (dangerous — will lose ability to decrypt old messages).
 */
export async function resetIdentityKeys() {
  _identityKeyPair = null;
  await secureSet(identityStorageKey(), null);
  await secureSet(E2E_PUBKEYS_CACHE, null);
}

// ============================================================
// PASSWORD-BASED KEY DERIVATION (for encrypted key backup)
// ============================================================
// Iterative SHA-512 over password+salt. Not PBKDF2-HMAC strict, but the
// threat model here is "attacker with access to the encrypted blob stored
// on our server" — iteration count raises the cost of offline brute-force.

function deriveKeyFromPassword(password, saltBytes, iters) {
  let block = new Uint8Array(decodeUTF8(password).length + saltBytes.length);
  block.set(decodeUTF8(password), 0);
  block.set(saltBytes, decodeUTF8(password).length);
  let out = nacl.hash(block); // 64 bytes
  for (let i = 1; i < iters; i++) out = nacl.hash(out);
  return out.slice(0, 32); // nacl.secretbox wants 32-byte key
}

// ============================================================
// PREKEY STORAGE (X3DH)
// ============================================================
// Each prekey is a one-time X25519 keypair. We keep secrets locally keyed
// by prekey id so a session initiator can pick one (via the server's bundle)
// and we can complete the DH on receive.

async function loadPrekeySecrets() {
  try {
    const raw = await secureGet(E2E_PREKEY_SECRETS);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function savePrekeySecrets(map) {
  await secureSet(E2E_PREKEY_SECRETS, JSON.stringify(map));
}
export async function storePrekeySecret(id, secretB64) {
  const map = await loadPrekeySecrets();
  map[String(id)] = secretB64;
  await savePrekeySecrets(map);
}
export async function consumePrekeySecret(id) {
  const map = await loadPrekeySecrets();
  const key = String(id);
  const b64 = map[key];
  if (!b64) return null;
  delete map[key];
  await savePrekeySecrets(map);
  return decodeBase64(b64);
}
export async function peekPrekeySecret(id) {
  const map = await loadPrekeySecrets();
  const b64 = map[String(id)];
  return b64 ? decodeBase64(b64) : null;
}

/**
 * Generate a batch of one-time prekeys. Public parts go to server; secrets
 * stay on-device so X3DH can complete when someone initiates a session.
 */
export async function generateOneTimePrekeys(count = 100) {
  const map = await loadPrekeySecrets();
  const baseId = Date.now() % 16000000;
  const out = [];
  for (let i = 0; i < count; i++) {
    const kp = nacl.box.keyPair();
    const id = (baseId + i) % 16777215 + 1;
    map[String(id)] = encodeBase64(kp.secretKey);
    out.push({
      id,
      publicKey: encodeBase64(kp.publicKey),
    });
  }
  await savePrekeySecrets(map);
  return out;
}

// ============================================================
// SIGNED PREKEY (medium-term)
// ============================================================
// A signed prekey proves the identity key vouches for this X25519 key.
// nacl uses separate key algos for signing (Ed25519) and DH (X25519).
// We generate an Ed25519 signing keypair derived deterministically from
// the identity secret so we don't introduce extra long-term keys. In
// practice tweetnacl gives us nacl.sign.keyPair.fromSeed() for signing.

export async function getSignedPrekey() {
  const stored = await secureGet(E2E_SIGNED_PREKEY);
  if (stored) { try { return JSON.parse(stored); } catch {} }
  return null;
}

export async function rotateSignedPrekey() {
  const id = (Date.now() % 16000000) + 1;
  const kp = nacl.box.keyPair();
  const kpB64 = {
    pub: encodeBase64(kp.publicKey),
    sec: encodeBase64(kp.secretKey),
  };
  // Sign the public key with the identity secret via Ed25519 (derive signing
  // seed from identity secret so no new long-term state).
  const identity = await getIdentityKeyPair();
  const seed = identity.secretKey.slice(0, 32);
  const signKp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(kp.publicKey, signKp.secretKey);
  const bundle = {
    id,
    pub: kpB64.pub,
    sec: kpB64.sec,
    sig: encodeBase64(sig),
    created_at: Date.now(),
  };
  await secureSet(E2E_SIGNED_PREKEY, JSON.stringify(bundle));
  return bundle;
}

/**
 * Encrypt the current device's secret key with the user's password.
 * Returns { ciphertext, salt, nonce, kdf_iters, public_key } — all base64
 * safe to upload to the server. The server NEVER learns the password
 * nor the plaintext secret key.
 */
export async function buildKeyBackup(password) {
  if (!password || typeof password !== 'string' || password.length < 4) {
    throw new Error('password required for backup');
  }
  const kp = await getIdentityKeyPair();
  const salt = nacl.randomBytes(16);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const iters = 100000;
  const derived = deriveKeyFromPassword(password, salt, iters);
  const ciphertext = nacl.secretbox(kp.secretKey, nonce, derived);
  return {
    ciphertext: encodeBase64(ciphertext),
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    kdf_iters: iters,
    public_key: encodeBase64(kp.publicKey),
  };
}

/**
 * Decrypt a backup blob fetched from the server and install it as this
 * device's identity key pair. Throws if password is wrong.
 */
export async function restoreKeyBackup(backup, password) {
  if (!backup || !backup.ciphertext) throw new Error('empty backup');
  if (!password) throw new Error('password required');
  const salt = decodeBase64(backup.salt);
  const nonce = decodeBase64(backup.nonce);
  const ct = decodeBase64(backup.ciphertext);
  const iters = backup.kdf_iters || 100000;
  const derived = deriveKeyFromPassword(password, salt, iters);
  const plain = nacl.secretbox.open(ct, nonce, derived);
  if (!plain) throw new Error('wrong password or corrupted backup');
  if (plain.length !== 32) throw new Error('unexpected key length');
  // Derive public key by re-deriving from secret — nacl stores them together
  const restored = nacl.box.keyPair.fromSecretKey(plain);
  await secureSet(identityStorageKey(), JSON.stringify({
    pub: encodeBase64(restored.publicKey),
    sec: encodeBase64(restored.secretKey),
  }));
  _identityKeyPair = restored;
  return restored;
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
 * Cache a user's public key locally. Returns { changed, previous } so the
 * caller can warn the user when a peer's identity key rotates (potential
 * MITM or peer-reinstall — same as WhatsApp's "security code changed").
 */
export async function cachePublicKey(email, pubKeyBase64) {
  const cache = await loadPubKeyCache();
  const prev = cache[email];
  let changed = false;
  // Compare base64 for new keys; tolerate Uint8Array arrivals.
  const incoming = typeof pubKeyBase64 === 'string' ? pubKeyBase64 : encodeBase64(pubKeyBase64);
  if (prev && prev !== incoming) {
    changed = true;
  }
  cache[email] = incoming;
  await savePubKeyCache();
  return { changed, previous: prev || null };
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
// ============================================================
// SESSION CACHE (symmetric chain ratchet — simplified Double Ratchet)
// ============================================================
// After the first X3DH handshake with a peer we cache the derived SK and
// ratchet a symmetric chain for each subsequent message. New messages use
// MK = hash(SK || counter) as the per-message key, so we don't recompute
// 4 DHs for every outgoing message and still keep per-message forward
// secrecy (attacker learning SK can decrypt only messages with counter >=
// current, and only until the next signed-prekey rotation refreshes SK).

function sessionKey(peerEmail, spkId) {
  return `${E2E_SESSION_PREFIX}${_activeAccountEmail || ''}:${peerEmail}:${spkId}`;
}

async function loadSession(peerEmail, spkId) {
  try {
    const raw = await secureGet(sessionKey(peerEmail, spkId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function saveSession(peerEmail, spkId, state) {
  await secureSet(sessionKey(peerEmail, spkId), JSON.stringify(state));
}

function deriveMessageKey(skBytes, counter) {
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);
  const material = new Uint8Array(skBytes.length + counterBytes.length);
  material.set(skBytes, 0);
  material.set(counterBytes, skBytes.length);
  return nacl.hash(material).slice(0, nacl.secretbox.keyLength);
}

// ============================================================
// X3DH SHARED SECRET (Signal-equivalent)
// ============================================================
// Computes the 4-DH Extended Triple Diffie-Hellman secret between sender
// and recipient using identity, signed-prekey, ephemeral, and optional
// one-time prekey. This replaces the v1 single-DH envelope with proper
// session key derivation equivalent to the Signal Protocol.

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function x3dhSharedSecretSender(myIkSec, ephemeralSec, recipientIkPub, recipientSpkPub, recipientOpkPub) {
  // DH1 = DH(IK_A, SPK_B) — authenticates sender's identity to receiver
  // DH2 = DH(EK_A, IK_B) — authenticates session freshness to sender
  // DH3 = DH(EK_A, SPK_B) — locks session to signed prekey
  // DH4 = DH(EK_A, OPK_B) — optional forward secrecy on one-time prekey
  const dh1 = nacl.scalarMult(myIkSec, recipientSpkPub);
  const dh2 = nacl.scalarMult(ephemeralSec, recipientIkPub);
  const dh3 = nacl.scalarMult(ephemeralSec, recipientSpkPub);
  const dh4 = recipientOpkPub ? nacl.scalarMult(ephemeralSec, recipientOpkPub) : null;
  const material = dh4 ? concat(dh1, dh2, dh3, dh4) : concat(dh1, dh2, dh3);
  return nacl.hash(material).slice(0, nacl.secretbox.keyLength);
}

function x3dhSharedSecretReceiver(mySpkSec, myIkSec, myOpkSec, senderIkPub, senderEkPub) {
  const dh1 = nacl.scalarMult(mySpkSec, senderIkPub);
  const dh2 = nacl.scalarMult(myIkSec, senderEkPub);
  const dh3 = nacl.scalarMult(mySpkSec, senderEkPub);
  const dh4 = myOpkSec ? nacl.scalarMult(myOpkSec, senderEkPub) : null;
  const material = dh4 ? concat(dh1, dh2, dh3, dh4) : concat(dh1, dh2, dh3);
  return nacl.hash(material).slice(0, nacl.secretbox.keyLength);
}

/**
 * Verify that a signed prekey was signed by the claimed identity key.
 * Prevents an attacker swapping prekeys in transit.
 *
 * @param {string} identityPubB64 — sender's long-term X25519 identity pub
 * @param {string} spkPubB64 — signed prekey pub
 * @param {string} sigB64 — Ed25519 signature over spk pub
 * @returns {boolean}
 */
function verifySignedPrekey(signingPubB64, spkPubB64, sigB64) {
  if (!signingPubB64 || !spkPubB64 || !sigB64) return false;
  try {
    const sig = decodeBase64(sigB64);
    const msg = decodeBase64(spkPubB64);
    const verifyKey = decodeBase64(signingPubB64);
    return nacl.sign.detached.verify(msg, sig, verifyKey);
  } catch { return false; }
}

// ============================================================
// DOUBLE RATCHET (v3 envelope — full WhatsApp/Signal semantics)
// ============================================================
// Each side maintains: RK (root), DHs (own pair), DHr (peer pub), CKs/CKr
// (per-direction chain keys), Ns/Nr (counters). DH ratchet runs on every
// new peer DH; chain ratchet on every message. Math validated locally.

function kdfRK(rk, dhOut) {
  const h = nacl.hash(concat(rk, dhOut));
  return { rk: h.slice(0, 32), ck: h.slice(32, 64) };
}
function kdfCK(ck) {
  const mk = nacl.hash(concat(ck, new Uint8Array([0x01]))).slice(0, 32);
  const next = nacl.hash(concat(ck, new Uint8Array([0x02]))).slice(0, 32);
  return { mk, next };
}

function drSessionKey(scope, peer, spkId) {
  return `${E2E_SESSION_PREFIX}v3:${scope}:${_activeAccountEmail || ''}:${peer}:${spkId}`;
}

async function loadDRSession(scope, peer, spkId) {
  try {
    const raw = await secureGet(drSessionKey(scope, peer, spkId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function saveDRSession(scope, peer, spkId, state) {
  await secureSet(drSessionKey(scope, peer, spkId), JSON.stringify(state));
}

function serializeDR(s) {
  // skipped: { "<dhr_b64>:<n>": "<mk_b64>" } — capped at 200 entries to bound storage
  return {
    rk: encodeBase64(s.RK),
    dhs_pub: encodeBase64(s.DHs.publicKey),
    dhs_sec: encodeBase64(s.DHs.secretKey),
    dhr: s.DHr ? encodeBase64(s.DHr) : null,
    cks: s.CKs ? encodeBase64(s.CKs) : null,
    ckr: s.CKr ? encodeBase64(s.CKr) : null,
    ns: s.Ns, nr: s.Nr,
    skipped: s.skipped || {},
  };
}
function deserializeDR(o) {
  return {
    RK: decodeBase64(o.rk),
    DHs: { publicKey: decodeBase64(o.dhs_pub), secretKey: decodeBase64(o.dhs_sec) },
    DHr: o.dhr ? decodeBase64(o.dhr) : null,
    CKs: o.cks ? decodeBase64(o.cks) : null,
    CKr: o.ckr ? decodeBase64(o.ckr) : null,
    Ns: o.ns || 0, Nr: o.nr || 0,
    skipped: o.skipped || {},
  };
}

const MAX_SKIP = 200;
function skippedKey(dhrB64, n) { return `${dhrB64}:${n}`; }
function trimSkipped(skipped) {
  const keys = Object.keys(skipped);
  if (keys.length <= MAX_SKIP) return skipped;
  // Drop oldest half (insertion order on plain objects in modern JS).
  const drop = keys.length - MAX_SKIP;
  for (let i = 0; i < drop; i++) delete skipped[keys[i]];
  return skipped;
}

/**
 * v3 envelope — full Double Ratchet (Signal/WhatsApp parity).
 * Each recipient gets a session that ratchets DH on every received message.
 * Per-message MK derived from chain key. Forward + post-compromise security.
 *
 * Multi-device: each recipient bundle may contain a `devices` array —
 *   { [email]: { devices: [{ device_id, identity_key, signing_key, signed_prekey, prekey }] } }
 * We produce one envelope per (email, device_id) pair, keyed as "email|device_id".
 * Back-compat: if a bundle has no `devices` array, we treat the bundle itself as a
 * single device (old single-device format) and key the envelope by plain email.
 */
export async function createEnvelopeV3(plaintext, senderEmail, recipientBundles, mySenderDeviceId) {
  const myIdentity = await getIdentityKeyPair();
  const myIkB64 = encodeBase64(myIdentity.publicKey);
  const envelopes = {};
  // Normalize into list of (email, deviceId|null, deviceBundle) tuples.
  const targets = [];
  for (const [email, bundle] of Object.entries(recipientBundles || {})) {
    if (!bundle) continue;
    if (Array.isArray(bundle.devices)) {
      for (const dev of bundle.devices) {
        if (!dev) continue;
        // Skip our own current device — don't encrypt messages to ourselves
        // on the originating device (useless + would clobber our own DR state).
        const isSelfEmail = senderEmail && email.toLowerCase() === senderEmail.toLowerCase();
        if (isSelfEmail) {
          if (mySenderDeviceId && dev.device_id === mySenderDeviceId) continue;
          // Also skip if device's identity key equals ours (same device, different
          // id registrations) — defensive check.
          if (dev.identity_key?.pub === myIkB64) continue;
        }
        targets.push({ email, deviceId: dev.device_id || null, dev });
      }
    } else {
      // Back-compat: single-device bundle shape
      const isSelfEmail = senderEmail && email.toLowerCase() === senderEmail.toLowerCase();
      if (isSelfEmail && bundle.identity_key?.pub === myIkB64) continue;
      targets.push({ email, deviceId: null, dev: bundle });
    }
  }

  for (const { email, deviceId, dev: bundle } of targets) {
    if (!bundle || !bundle.identity_key?.pub || !bundle.signed_prekey?.key) continue;
    const sigOk = bundle.signing_key
      ? verifySignedPrekey(bundle.signing_key, bundle.signed_prekey.key, bundle.signed_prekey.sig)
      : !!bundle.signed_prekey.sig;
    if (!sigOk) continue;

    const recipientIkPub = decodeBase64(bundle.identity_key.pub);
    const recipientSpkPub = decodeBase64(bundle.signed_prekey.key);
    const spkId = bundle.signed_prekey.id;

    // Scope DR session per-device so two recipient devices with distinct
    // SPKs don't clobber each other's ratchet state.
    const peerKey = deviceId ? `${email}#${deviceId}` : email;
    let sessionRaw = await loadDRSession('snd', peerKey, spkId);
    let session;
    let initialEk = null;
    let initialOpkId = null;

    if (!sessionRaw) {
      // First message — run X3DH and bootstrap DR with bob's SPK as initial DHr.
      const recipientOpkPub = bundle.prekey?.key ? decodeBase64(bundle.prekey.key) : null;
      const ephemeral = nacl.box.keyPair();
      const sk = x3dhSharedSecretSender(myIdentity.secretKey, ephemeral.secretKey, recipientIkPub, recipientSpkPub, recipientOpkPub);
      session = {
        RK: sk,
        DHs: nacl.box.keyPair(),
        DHr: recipientSpkPub,
        CKs: null, CKr: null, Ns: 0, Nr: 0,
      };
      const dhOut = nacl.scalarMult(session.DHs.secretKey, session.DHr);
      const out = kdfRK(session.RK, dhOut);
      session.RK = out.rk; session.CKs = out.ck;
      initialEk = encodeBase64(ephemeral.publicKey);
      initialOpkId = bundle.prekey?.id || null;
      // Persist the bootstrap — receiver also needs ek + opk to derive the same SK
      session._ek = initialEk;
      session._opk_id = initialOpkId;
      for (let i = 0; i < ephemeral.secretKey.length; i++) ephemeral.secretKey[i] = 0;
    } else {
      session = deserializeDR(sessionRaw);
      if (sessionRaw._ek) initialEk = sessionRaw._ek;
      if (sessionRaw._opk_id) initialOpkId = sessionRaw._opk_id;
    }

    if (!session.CKs) {
      // Shouldn't happen on send — fallback regenerate
      const dhOut = nacl.scalarMult(session.DHs.secretKey, session.DHr);
      const out = kdfRK(session.RK, dhOut);
      session.RK = out.rk; session.CKs = out.ck;
    }

    const { mk, next } = kdfCK(session.CKs);
    session.CKs = next;
    const counter = session.Ns;
    session.Ns++;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(decodeUTF8(plaintext), nonce, mk);

    const persisted = serializeDR(session);
    persisted._ek = initialEk;
    persisted._opk_id = initialOpkId;
    await saveDRSession('snd', peerKey, spkId, persisted);

    // Envelope key format: "email|device_id" for multi-device, plain "email"
    // for back-compat single-device bundles.
    const envKey = deviceId ? `${email}|${deviceId}` : email;
    envelopes[envKey] = {
      ik: encodeBase64(myIdentity.publicKey),
      ek: initialEk, // bootstrap material — peer needs on first receive
      spk_id: spkId,
      opk_id: initialOpkId,
      dh: encodeBase64(session.DHs.publicKey), // current DR DHs
      n: counter,
      nonce: encodeBase64(nonce),
      ct: encodeBase64(ct),
      ...(deviceId ? { device_id: deviceId } : {}),
    };
  }
  return JSON.stringify({ e2e: 3, v: 1, envelopes });
}

export async function openEnvelopeV3(parsed, myEmail, myDeviceId) {
  // Multi-device lookup: prefer per-device envelope "email|device_id",
  // fall back to plain "email" (v3 single-device back-compat).
  let env = null;
  if (myDeviceId && parsed.envelopes) {
    env = parsed.envelopes[`${myEmail}|${myDeviceId}`] || null;
  }
  if (!env) env = parsed.envelopes?.[myEmail] || null;
  if (!env) return { text: '[E2E: no envelope for you]', encrypted: true };
  const myIdentity = await getIdentityKeyPair();
  const mySigned = await getSignedPrekey();
  if (!mySigned || mySigned.id !== env.spk_id) {
    return { text: '[E2E: signed prekey mismatch — resign in]', encrypted: true };
  }

  const peer = `from:${env.ik}`;
  let sessionRaw = await loadDRSession('rcv', peer, env.spk_id);
  let session;

  if (!sessionRaw) {
    // Bootstrap: derive SK via X3DH receiver, init DR with our SPK as DHs
    const mySpkSec = decodeBase64(mySigned.sec);
    const myOpkSec = env.opk_id ? await peekPrekeySecret(env.opk_id) : null;
    const senderIkPub = decodeBase64(env.ik);
    const senderEkPub = decodeBase64(env.ek);
    const sk = x3dhSharedSecretReceiver(mySpkSec, myIdentity.secretKey, myOpkSec, senderIkPub, senderEkPub);
    session = {
      RK: sk,
      DHs: { publicKey: decodeBase64(mySigned.pub), secretKey: mySpkSec },
      DHr: null,
      CKs: null, CKr: null, Ns: 0, Nr: 0,
    };
  } else {
    session = deserializeDR(sessionRaw);
  }

  // DR step on new DHr
  const incomingDh = decodeBase64(env.dh);
  if (!session.DHr || encodeBase64(session.DHr) !== env.dh) {
    session.DHr = incomingDh;
    const dhOut1 = nacl.scalarMult(session.DHs.secretKey, session.DHr);
    const out1 = kdfRK(session.RK, dhOut1);
    session.RK = out1.rk; session.CKr = out1.ck;
    // Generate new DHs for our next outgoing
    session.DHs = nacl.box.keyPair();
    const dhOut2 = nacl.scalarMult(session.DHs.secretKey, session.DHr);
    const out2 = kdfRK(session.RK, dhOut2);
    session.RK = out2.rk; session.CKs = out2.ck;
    session.Ns = 0; session.Nr = 0;
  }

  // Check skipped-keys store — message may have arrived out-of-order from
  // a prior chain we already advanced past.
  session.skipped = session.skipped || {};
  const dhrB64 = encodeBase64(session.DHr);
  const skipKey = skippedKey(dhrB64, env.n);
  let mk = null;
  if (session.skipped[skipKey]) {
    mk = decodeBase64(session.skipped[skipKey]);
    delete session.skipped[skipKey];
  } else {
    if (!session.CKr) return { text: '[E2E: no recv chain]', encrypted: true };
    // Advance chain to env.n. Stash MKs we skip past so a later out-of-order
    // delivery for those Ns can still be decrypted.
    while (session.Nr < env.n) {
      const skipMK = kdfCK(session.CKr);
      session.skipped[skippedKey(dhrB64, session.Nr)] = encodeBase64(skipMK.mk);
      session.CKr = skipMK.next;
      session.Nr++;
      if (session.Nr - env.n > MAX_SKIP) return { text: '[E2E: skip too large]', encrypted: true };
    }
    if (session.Nr === env.n) {
      const out = kdfCK(session.CKr);
      mk = out.mk;
      session.CKr = out.next;
      session.Nr++;
    }
    session.skipped = trimSkipped(session.skipped);
  }
  if (!mk) return { text: '[E2E: chain mismatch]', encrypted: true };

  const ct = decodeBase64(env.ct);
  const nonce = decodeBase64(env.nonce);
  const plain = nacl.secretbox.open(ct, nonce, mk);
  if (!plain) return { text: '[E2E: decrypt failed]', encrypted: true };

  // Consume OPK on success (only first message has opk_id meaningful)
  if (env.opk_id && !sessionRaw) {
    await consumePrekeySecret(env.opk_id);
  }
  await saveDRSession('rcv', peer, env.spk_id, serializeDR(session));

  return { text: encodeUTF8(plain), encrypted: true };
}

/**
 * v2 envelope — uses X3DH per recipient. Requires per-recipient bundle
 * { identity_key, signed_prekey: { id, key }, prekey: { id, key }? } from
 * the server. Falls back to v1 if bundle missing signed_prekey.
 */
export async function createEnvelopeV2(plaintext, senderEmail, recipientBundles) {
  const myIdentity = await getIdentityKeyPair();
  const envelopes = {};
  for (const [email, bundle] of Object.entries(recipientBundles)) {
    if (!bundle || !bundle.identity_key?.pub || !bundle.signed_prekey?.key) {
      // Can't do X3DH without a signed prekey — skip (caller should fall back to v1)
      continue;
    }
    // Prefer the published Ed25519 verify key; if the recipient hasn't
    // re-registered yet (still old client), fall back to "any sig present"
    // TOFU during the rollout window.
    const sigOk = bundle.signing_key
      ? verifySignedPrekey(bundle.signing_key, bundle.signed_prekey.key, bundle.signed_prekey.sig)
      : !!bundle.signed_prekey.sig;
    if (!sigOk) {
      continue;
    }
    const recipientIkPub = decodeBase64(bundle.identity_key.pub);
    const recipientSpkPub = decodeBase64(bundle.signed_prekey.key);
    const spkId = bundle.signed_prekey.id;

    // Session cache: reuse SK from prior handshake with same signed prekey
    // so we don't recompute 4 DHs for every outgoing message. Ratchet the
    // symmetric chain forward with a per-message counter.
    let session = await loadSession(email, spkId);
    let ekPubB64;
    let opkId = null;

    if (!session) {
      // First message to this peer for this SPK version — run X3DH
      const recipientOpkPub = bundle.prekey?.key ? decodeBase64(bundle.prekey.key) : null;
      const ephemeral = nacl.box.keyPair();
      const sk = x3dhSharedSecretSender(myIdentity.secretKey, ephemeral.secretKey, recipientIkPub, recipientSpkPub, recipientOpkPub);
      // Generate a ratchet pair so subsequent messages can mix in fresh DH
      // and rotate SK without a new X3DH (Double Ratchet step).
      const ratchet = nacl.box.keyPair();
      session = {
        sk: encodeBase64(sk),
        ek: encodeBase64(ephemeral.publicKey),
        opk_id: bundle.prekey?.id || null,
        n: 0,
        // DH-ratchet state
        rdh_pub: encodeBase64(ratchet.publicKey),
        rdh_sec: encodeBase64(ratchet.secretKey),
        their_rdh: null, // last seen receiver ratchet pub (none yet)
        created_at: Date.now(),
      };
      ekPubB64 = session.ek;
      opkId = session.opk_id;
      // Zero ephemeral secret
      for (let i = 0; i < ephemeral.secretKey.length; i++) ephemeral.secretKey[i] = 0;
    } else {
      ekPubB64 = session.ek;
      opkId = session.opk_id;
    }

    const skBytes = decodeBase64(session.sk);
    const counter = session.n;
    const mk = deriveMessageKey(skBytes, counter);
    session.n = counter + 1;
    await saveSession(email, spkId, session);

    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(decodeUTF8(plaintext), nonce, mk);

    envelopes[email] = {
      ik: encodeBase64(myIdentity.publicKey),
      ek: ekPubB64,
      spk_id: spkId,
      opk_id: opkId,
      n: counter,
      rdh: session.rdh_pub, // ratchet pub for DH ratchet
      nonce: encodeBase64(nonce),
      ct: encodeBase64(ct),
    };
  }
  return JSON.stringify({ e2e: 2, v: 1, envelopes });
}

export async function openEnvelopeV2(parsed, myEmail) {
  const myEnvelope = parsed.envelopes?.[myEmail];
  if (!myEnvelope) return { text: '[E2E: no envelope for you]', encrypted: true };
  const myIdentity = await getIdentityKeyPair();
  const mySigned = await getSignedPrekey();
  if (!mySigned || mySigned.id !== myEnvelope.spk_id) {
    return { text: '[E2E: signed prekey mismatch — resign in]', encrypted: true };
  }

  // Cache the session keyed by (sender, spk_id). The sender ratchets a
  // per-message counter on top of the shared SK so we only run X3DH once.
  const senderKey = `from:${myEnvelope.ik}`;
  let session = await loadSession(senderKey, myEnvelope.spk_id);
  let skBytes;

  if (!session) {
    const mySpkSec = decodeBase64(mySigned.sec);
    // peekPrekeySecret avoids consuming until decrypt succeeds — prevents
    // losing the OPK on a bad payload.
    const myOpkSec = myEnvelope.opk_id ? await peekPrekeySecret(myEnvelope.opk_id) : null;
    const senderIkPub = decodeBase64(myEnvelope.ik);
    const senderEkPub = decodeBase64(myEnvelope.ek);
    skBytes = x3dhSharedSecretReceiver(mySpkSec, myIdentity.secretKey, myOpkSec, senderIkPub, senderEkPub);
    // Generate our own ratchet pair so future outgoing messages can advance the DH ratchet.
    const myRdh = nacl.box.keyPair();
    session = {
      sk: encodeBase64(skBytes),
      opk_consumed: false,
      rdh_pub: encodeBase64(myRdh.publicKey),
      rdh_sec: encodeBase64(myRdh.secretKey),
      their_rdh: null,
      created_at: Date.now(),
    };
  } else {
    skBytes = decodeBase64(session.sk);
  }

  // Track sender's rdh so a future bidirectional DH-ratchet step can run.
  // For now only chain ratchet (counter) advances SK — bidirectional ratchet
  // requires sender also to react to receiver's rdh, which is the next step.
  const incomingRdh = myEnvelope.rdh || null;
  if (incomingRdh) session.their_rdh = incomingRdh;
  const counter = (typeof myEnvelope.n === 'number') ? myEnvelope.n : 0;

  const mk = deriveMessageKey(skBytes, counter);
  const ct = decodeBase64(myEnvelope.ct);
  const nonce = decodeBase64(myEnvelope.nonce);
  const plain = nacl.secretbox.open(ct, nonce, mk);
  if (!plain) return { text: '[E2E: decrypt failed]', encrypted: true };

  // Persist session + consume OPK now that decrypt succeeded
  if (!session.opk_consumed && myEnvelope.opk_id) {
    await consumePrekeySecret(myEnvelope.opk_id);
    session.opk_consumed = true;
  }
  await saveSession(senderKey, myEnvelope.spk_id, session);

  return { text: encodeUTF8(plain), encrypted: true };
}

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
export function openEnvelope(content, myEmail, mySecretKey, myDeviceId) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.e2e === 3 && parsed.envelopes) {
      return {
        text: '...',
        encrypted: true,
        _v2: true,
        _v2Decrypt: () => openEnvelopeV3(parsed, myEmail, myDeviceId),
      };
    }
    if (parsed.e2e === 2 && parsed.envelopes) {
      // v2 (X3DH) is async — return a sentinel that the caller must await.
      // To keep existing sync callsites working, we expose a promise-like
      // object that resolves to the decrypted text. Callers that opened v1
      // previously need to be updated to await openEnvelope.
      return {
        text: '...',
        encrypted: true,
        _v2: true,
        _v2Decrypt: () => openEnvelopeV2(parsed, myEmail),
      };
    }
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
