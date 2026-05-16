/**
 * services/envelope.js — Per-device encrypted envelope helpers
 * (SQLite-first chat migration, Stage 5).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO SHAPES live in this file:
 *
 *   (A) Legacy per-device envelope (buildEnvelopes / decryptEnvelope).
 *       Every recipient device receives its own full-message nacl.box
 *       ciphertext + ephemeral pubkey + nonce. Cost = N * full-message
 *       encryptions for a fan-out of N devices. Kept for back-compat
 *       with rolled-out clients.
 *
 *   (B) Sender-Keys envelope (buildSenderKeysEnvelope /
 *       decryptSenderKeysEnvelope). Inspired by WhatsApp / Signal
 *       Sender-Keys. We generate ONE random 32-byte "messageKey",
 *       symmetrically encrypt the body once via nacl.secretbox
 *       (XSalsa20-Poly1305 — authenticated, no GCM needed in RN),
 *       then nacl.box-wrap the 32-byte messageKey per recipient device.
 *       Cost = 1 full-message secretbox + N * 32-byte-key boxes for a
 *       fan-out of N devices. For a 1KB message into 40 devices,
 *       this is roughly 40× less CPU and bandwidth on the body.
 *
 *       For 1:1 single-device chats, this is identical CPU to (A):
 *       one secretbox + one box(32B) vs one box(N-bytes). No regression.
 *
 * Gating: callers should pick the new path when
 *   globalThis.__chatyy_envelope_sender_keys === true.
 * Default OFF. The old buildEnvelopes export is preserved for any
 * caller that hasn't migrated.
 *
 * NOTE FOR INTEGRATORS: services/api.js#chatEnvelopeSend currently
 * destructures only {conversation_id, client_message_id, envelopes}.
 * To wire the Sender-Keys path end-to-end, that forwarder needs to
 * also accept {body, keys} and pass them through to the
 * chat_envelope_send POST. The PHP endpoint detects the shape by the
 * presence of a `body` field and routes accordingly. Until api.js is
 * extended (owned by a different agent in this task split), the
 * Sender-Keys exports here are only reachable by a custom caller.
 *
 *   sender ── secretbox(plaintext, nonce, messageKey) ──▶ body
 *          ── box(messageKey, nonce, recipDevicePub, ephSec) ──▶ keys[i]
 *                      │
 *                      ▼
 *   receiver pulls body+keys[me] ─▶ box.open ⇒ messageKey
 *                                ─▶ secretbox.open ⇒ plaintext
 * ─────────────────────────────────────────────────────────────────────────
 *
 * No new crypto deps — tweetnacl + tweetnacl-util only.
 */

import nacl from 'tweetnacl';
import {
  encodeBase64,
  decodeBase64,
  decodeUTF8,
  encodeUTF8,
} from 'tweetnacl-util';

// ─── Shared input normalizer ─────────────────────────────────────────────
function _normalizeTargets(recipientDevicePubkeys) {
  const targets = [];
  if (recipientDevicePubkeys instanceof Map) {
    for (const [deviceId, entry] of recipientDevicePubkeys.entries()) {
      if (!entry || !entry.pubkey || !entry.email) continue;
      targets.push({ device_id: deviceId, email: entry.email, pubkey: entry.pubkey });
    }
  } else if (Array.isArray(recipientDevicePubkeys)) {
    for (const t of recipientDevicePubkeys) {
      if (!t || !t.pubkey || !t.device_id || !t.email) continue;
      targets.push(t);
    }
  } else {
    throw new Error('recipientDevicePubkeys must be a Map or Array');
  }
  return targets;
}

/**
 * @deprecated since 2026-05-16. See buildSenderKeysEnvelope.
 *
 * Build the per-device envelope array for a single outgoing message
 * using the legacy "encrypt the whole message N times" pattern.
 *
 * @param {string} text — plaintext message body
 * @param {number|string} conversationId — routing only (not in ciphertext)
 * @param {Map<string, {email: string, pubkey: string}> |
 *         Array<{device_id: string, email: string, pubkey: string}>}
 *         recipientDevicePubkeys
 *
 * @returns {Array<{
 *   recipient_email: string,
 *   recipient_device_id: string,
 *   ciphertext: string,         // base64 nacl.box output
 *   ephemeral_pubkey: string,   // base64 X25519 pubkey (per-envelope)
 *   nonce: string,              // base64
 * }>}
 */
export function buildEnvelopes(text, conversationId, recipientDevicePubkeys) {
  if (typeof text !== 'string') {
    throw new Error('buildEnvelopes: text must be a string');
  }
  const messageBytes = decodeUTF8(text);
  const targets = _normalizeTargets(recipientDevicePubkeys);

  const envelopes = [];
  for (const target of targets) {
    try {
      const recipPub = decodeBase64(target.pubkey);
      const ephemeral = nacl.box.keyPair();
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ct = nacl.box(messageBytes, nonce, recipPub, ephemeral.secretKey);
      envelopes.push({
        recipient_email: target.email,
        recipient_device_id: target.device_id,
        ciphertext: encodeBase64(ct),
        ephemeral_pubkey: encodeBase64(ephemeral.publicKey),
        nonce: encodeBase64(nonce),
      });
    } catch (e) {
      console.warn('[envelope] skip device', target.device_id, e?.message);
    }
  }
  return envelopes;
}

/**
 * Decrypt a legacy (per-device) envelope row.
 *
 * @param {{ciphertext: string, ephemeral_pubkey: string, nonce: string}} envelope
 * @param {Uint8Array} mySecretKey — this device's X25519 secret key
 * @returns {string} plaintext
 * @throws {Error} on decryption failure
 */
export function decryptEnvelope(envelope, mySecretKey) {
  if (!envelope || !envelope.ciphertext || !envelope.ephemeral_pubkey || !envelope.nonce) {
    throw new Error('decryptEnvelope: malformed envelope');
  }
  if (!(mySecretKey instanceof Uint8Array)) {
    throw new Error('decryptEnvelope: mySecretKey must be Uint8Array');
  }
  const ct = decodeBase64(envelope.ciphertext);
  const nonce = decodeBase64(envelope.nonce);
  const ephPub = decodeBase64(envelope.ephemeral_pubkey);
  const opened = nacl.box.open(ct, nonce, ephPub, mySecretKey);
  if (!opened) {
    throw new Error('decryptEnvelope: nacl.box.open returned null (key mismatch or tampered ciphertext)');
  }
  return encodeUTF8(opened);
}

// ─────────────────────────────────────────────────────────────────────────
// Sender-Keys path (new, 2026-05-16)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a Sender-Keys-style envelope for a single outgoing message.
 *
 * Algorithm:
 *   1. Random 32-byte messageKey  (nacl.secretbox.keyLength)
 *   2. Random 24-byte body nonce  (nacl.secretbox.nonceLength)
 *   3. body_ciphertext = nacl.secretbox(plaintextBytes, body_nonce, messageKey)
 *      → XSalsa20-Poly1305, authentication tag is embedded in the
 *        ciphertext, so we do NOT emit a separate `tag` field.
 *   4. For each recipient device:
 *      a. Fresh X25519 ephemeral keypair (per-device forward-secrecy
 *         boundary, same as legacy path).
 *      b. key_nonce = random 24 bytes (nacl.box.nonceLength)
 *      c. key_ciphertext = nacl.box(messageKey, key_nonce,
 *                                   recipDevicePub, ephemeral.secretKey)
 *
 * @param {string} text — plaintext body
 * @param {number|string} conversationId — routing only
 * @param {string} clientMessageId — sender-chosen dedup key (server uses it)
 * @param {Map | Array} recipientDevicePubkeys — same shape as buildEnvelopes
 *
 * @returns {{
 *   conversation_id: number|string,
 *   client_message_id: string,
 *   body: {
 *     ciphertext: string,   // base64 secretbox output (incl. embedded tag)
 *     iv: string,           // base64 24-byte secretbox nonce
 *     tag: null,            // unused for secretbox (kept for AES-GCM future)
 *     algo: 'nacl_secretbox'
 *   },
 *   keys: Array<{
 *     recipient_email: string,
 *     recipient_device_id: string,
 *     key_ciphertext: string,        // base64 nacl.box(messageKey)
 *     key_ephemeral_pubkey: string,  // base64 X25519 pubkey
 *     key_nonce: string,             // base64 24-byte box nonce
 *   }>
 * }}
 */
export function buildSenderKeysEnvelope(text, conversationId, clientMessageId, recipientDevicePubkeys) {
  if (typeof text !== 'string') {
    throw new Error('buildSenderKeysEnvelope: text must be a string');
  }
  if (!clientMessageId || typeof clientMessageId !== 'string') {
    throw new Error('buildSenderKeysEnvelope: clientMessageId is required');
  }
  const messageBytes = decodeUTF8(text);
  const targets = _normalizeTargets(recipientDevicePubkeys);

  // (1) messageKey + (2) body nonce — single random draws, one per send.
  const messageKey = nacl.randomBytes(nacl.secretbox.keyLength); // 32B
  const bodyNonce  = nacl.randomBytes(nacl.secretbox.nonceLength); // 24B

  // (3) symmetric body encryption — Poly1305 tag embedded in ciphertext.
  const bodyCt = nacl.secretbox(messageBytes, bodyNonce, messageKey);

  const body = {
    ciphertext: encodeBase64(bodyCt),
    iv:         encodeBase64(bodyNonce),
    tag:        null, // reserved for AES-GCM future; secretbox carries it inline
    algo:       'nacl_secretbox',
  };

  // (4) per-device key wrapping.
  const keys = [];
  for (const target of targets) {
    try {
      const recipPub  = decodeBase64(target.pubkey);
      const ephemeral = nacl.box.keyPair();
      const keyNonce  = nacl.randomBytes(nacl.box.nonceLength); // 24B
      const keyCt     = nacl.box(messageKey, keyNonce, recipPub, ephemeral.secretKey);
      keys.push({
        recipient_email:       target.email,
        recipient_device_id:   target.device_id,
        key_ciphertext:        encodeBase64(keyCt),
        key_ephemeral_pubkey:  encodeBase64(ephemeral.publicKey),
        key_nonce:             encodeBase64(keyNonce),
      });
    } catch (e) {
      // One bad device key doesn't kill the whole fan-out — receiver's
      // other surfaces still get a copy.
      console.warn('[envelope.sk] skip device', target.device_id, e?.message);
    }
  }

  // Zero out the local messageKey copy — best-effort, JS doesn't really
  // give us deterministic erasure, but it costs nothing.
  try { for (let i = 0; i < messageKey.length; i++) messageKey[i] = 0; } catch {}

  return {
    conversation_id:    conversationId,
    client_message_id:  clientMessageId,
    body,
    keys,
  };
}

/**
 * Decrypt a Sender-Keys envelope row received from chat_envelopes_pull (v2).
 *
 * @param {{ciphertext: string, iv: string, tag?: string|null, algo?: string}} body
 *   The shared body payload (one per message, shared across all recipients).
 * @param {{key_ciphertext: string, key_ephemeral_pubkey: string, key_nonce: string}} keyEnvelope
 *   The recipient-specific wrapped messageKey.
 * @param {Uint8Array} mySecretKey — this device's X25519 secret key
 * @returns {string} plaintext
 * @throws {Error} on decryption failure (bad key, tampered ciphertext, etc.)
 */
export function decryptSenderKeysEnvelope(body, keyEnvelope, mySecretKey) {
  if (!body || !body.ciphertext || !body.iv) {
    throw new Error('decryptSenderKeysEnvelope: malformed body');
  }
  if (!keyEnvelope || !keyEnvelope.key_ciphertext || !keyEnvelope.key_ephemeral_pubkey || !keyEnvelope.key_nonce) {
    throw new Error('decryptSenderKeysEnvelope: malformed keyEnvelope');
  }
  if (!(mySecretKey instanceof Uint8Array)) {
    throw new Error('decryptSenderKeysEnvelope: mySecretKey must be Uint8Array');
  }
  // Reject anything other than the algorithm we know — if a future
  // version adds AES-GCM, decrypt path needs explicit branching.
  if (body.algo && body.algo !== 'nacl_secretbox') {
    throw new Error('decryptSenderKeysEnvelope: unsupported body algo ' + body.algo);
  }

  // Step 1 — unwrap the messageKey for this device.
  const keyCt    = decodeBase64(keyEnvelope.key_ciphertext);
  const keyNonce = decodeBase64(keyEnvelope.key_nonce);
  const ephPub   = decodeBase64(keyEnvelope.key_ephemeral_pubkey);
  const messageKey = nacl.box.open(keyCt, keyNonce, ephPub, mySecretKey);
  if (!messageKey) {
    throw new Error('decryptSenderKeysEnvelope: key unwrap failed (nacl.box.open null)');
  }
  if (messageKey.length !== nacl.secretbox.keyLength) {
    throw new Error('decryptSenderKeysEnvelope: messageKey wrong length ' + messageKey.length);
  }

  // Step 2 — symmetric body decrypt with the freshly recovered key.
  try {
    const bodyCt    = decodeBase64(body.ciphertext);
    const bodyNonce = decodeBase64(body.iv);
    const opened    = nacl.secretbox.open(bodyCt, bodyNonce, messageKey);
    if (!opened) {
      throw new Error('decryptSenderKeysEnvelope: body open failed (tampered or wrong key)');
    }
    return encodeUTF8(opened);
  } finally {
    // Zero out the recovered key — same best-effort as above.
    try { for (let i = 0; i < messageKey.length; i++) messageKey[i] = 0; } catch {}
  }
}

/**
 * Feature-flag helper. Returns true iff the caller should use the new
 * Sender-Keys path. Centralised so consumers don't open-code the global.
 */
export function isSenderKeysEnabled() {
  try {
    return (typeof globalThis !== 'undefined') && globalThis.__chatyy_envelope_sender_keys === true;
  } catch { return false; }
}

export default {
  // Legacy
  buildEnvelopes,
  decryptEnvelope,
  // Sender-Keys (new)
  buildSenderKeysEnvelope,
  decryptSenderKeysEnvelope,
  isSenderKeysEnabled,
};
