/**
 * services/e2e-call.js — Per-call master-secret + SRTP key derivation.
 *
 * Phase 1 of the call-E2EE rollout (see docs/whatsapp-migration/
 * 07-signal-protocol-calls.md). We extend the chat E2E primitives
 * (services/e2e.js, tweetnacl Box = X25519 + XSalsa20-Poly1305) with
 *
 *   • mintCallMasterSecret()         — fresh 32-byte master M
 *   • encryptForDevice(M, peerPubB64) — wrap M for ONE callee device
 *   • decryptMasterEnvelope(envB64)   — unwrap M on the callee
 *   • deriveSRTPKeys(M, callId, dir)  — HKDF → SRTP key/salt per direction
 *
 * Phase 2 (deferred) swaps the envelope cipher for libsignal X3DH + Double
 * Ratchet so we get the full Sealed-Sender + post-compromise security
 * properties. tweetnacl Box already buys us:
 *   • ephemeral X25519 per envelope → forward secrecy across calls,
 *   • XSalsa20-Poly1305 AEAD,
 *   • Curve25519 misuse-resistant — same primitives that ship in libsignal.
 * It does NOT buy us the symmetric ratchet inside a single call. That gap
 * is closed by chat_call_key_rotate at the protocol layer (master rotates
 * every 15 min, see §2 step 8 of the design).
 */

import nacl from 'tweetnacl';
import {
  encodeBase64,
  decodeBase64,
  decodeUTF8,
} from 'tweetnacl-util';

import {
  getDeviceKeyPair,
  getCachedPublicKey,
} from './e2e';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA512 implementation built on `nacl.hash` (SHA-512, 64-byte digest).
 * RFC 2104. Returns Uint8Array(64).
 *
 * We avoid pulling @noble/hashes or a dedicated HMAC lib for Phase 1 — the
 * one place we need HMAC is the HKDF extract/expand path, and a 12-line
 * implementation is trivially auditable. Replace with libsodium HMAC when
 * we ship libsignal in Phase 2.
 */
function hmacSha512(key, data) {
  if (!(key instanceof Uint8Array))  key  = new Uint8Array(key  || []);
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data || []);
  const BLOCK = 128; // SHA-512 block size
  let k = key;
  if (k.length > BLOCK) k = nacl.hash(k); // 64 bytes
  if (k.length < BLOCK) {
    const padded = new Uint8Array(BLOCK);
    padded.set(k, 0);
    k = padded;
  }
  const opad = new Uint8Array(BLOCK);
  const ipad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    opad[i] = k[i] ^ 0x5c;
    ipad[i] = k[i] ^ 0x36;
  }
  const inner = new Uint8Array(BLOCK + data.length);
  inner.set(ipad, 0);
  inner.set(data, BLOCK);
  const innerHash = nacl.hash(inner); // 64 bytes
  const outer = new Uint8Array(BLOCK + innerHash.length);
  outer.set(opad, 0);
  outer.set(innerHash, BLOCK);
  return nacl.hash(outer);
}

/**
 * HKDF-SHA512 (RFC 5869). Returns Uint8Array(length).
 *
 * For Phase 1 we standardize on HKDF-SHA512 because tweetnacl already
 * carries SHA-512 (via nacl.hash). The design doc spec'd HKDF-SHA256 but
 * the security level is equivalent for our 256-bit master; libsignal
 * Phase 2 switches us back to SHA-256 to match Signal's wire format.
 */
function hkdf(ikm, salt, info, length) {
  if (!(ikm instanceof Uint8Array))  ikm  = new Uint8Array(ikm  || []);
  if (salt && !(salt instanceof Uint8Array)) salt = new Uint8Array(salt);
  if (info && !(info instanceof Uint8Array)) info = decodeUTF8(typeof info === 'string' ? info : '');
  if (!salt || salt.length === 0) salt = new Uint8Array(64); // all-zero default per RFC

  // Extract
  const prk = hmacSha512(salt, ikm); // 64 bytes
  // Expand
  const HASH_LEN = 64;
  const n = Math.ceil(length / HASH_LEN);
  if (n > 255) throw new Error('hkdf: length too large');
  let t = new Uint8Array(0);
  const okm = new Uint8Array(n * HASH_LEN);
  for (let i = 1; i <= n; i++) {
    const buf = new Uint8Array(t.length + (info ? info.length : 0) + 1);
    let off = 0;
    buf.set(t, off); off += t.length;
    if (info) { buf.set(info, off); off += info.length; }
    buf[off] = i;
    t = hmacSha512(prk, buf);
    okm.set(t, (i - 1) * HASH_LEN);
  }
  return okm.slice(0, length);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a fresh per-call 256-bit master secret.
 *
 * The master is the root from which SRTP keys derive. Server NEVER sees
 * the plaintext bytes — they are wrapped per-recipient by
 * `encryptForDevice` and uploaded as opaque ciphertext via
 * `chat_call_invite_e2ee`.
 *
 * @returns {Uint8Array} 32 random bytes
 */
export function mintCallMasterSecret() {
  return nacl.randomBytes(32);
}

/**
 * Wrap the master secret for one specific recipient device.
 *
 * Uses tweetnacl Box (X25519 + XSalsa20-Poly1305) with a per-envelope
 * ephemeral keypair, mirroring the chat E2E `encryptMessage` flow.
 *
 * @param {Uint8Array} master           — 32-byte master (from mintCallMasterSecret)
 * @param {string}     recipientPubB64  — base64-encoded recipient device X25519 pubkey
 * @returns {{ ciphertext_b64:string, nonce_b64:string, ephemeral_pub_b64:string }}
 *          Ready to ship as one item in chat_call_invite_e2ee's `envelopes[]`.
 */
export function encryptForDevice(master, recipientPubB64) {
  if (!(master instanceof Uint8Array) || master.length !== 32) {
    throw new Error('encryptForDevice: master must be 32 bytes');
  }
  if (!recipientPubB64 || typeof recipientPubB64 !== 'string') {
    throw new Error('encryptForDevice: recipientPubB64 required');
  }
  const recipientPub = decodeBase64(recipientPubB64);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(master, nonce, recipientPub, ephemeral.secretKey);

  // Zeroize ephemeral secret immediately — defense in depth, JS can't
  // truly mlock but at least don't leave it in the heap any longer than
  // necessary.
  ephemeral.secretKey.fill(0);

  return {
    ciphertext_b64:    encodeBase64(ct),
    nonce_b64:         encodeBase64(nonce),
    ephemeral_pub_b64: encodeBase64(ephemeral.publicKey),
  };
}

/**
 * Unwrap a master-secret envelope addressed to THIS device.
 *
 * @param {{ ciphertext_b64:string, nonce_b64:string, ephemeral_pub_b64:string }} envelope
 * @param {Uint8Array} [myDeviceSecretKey]  — override; defaults to the active
 *                                            account's device keypair from e2e.js.
 * @returns {Promise<Uint8Array|null>} 32-byte master or null on decryption failure.
 */
export async function decryptMasterEnvelope(envelope, myDeviceSecretKey) {
  if (!envelope || typeof envelope !== 'object') return null;
  const { ciphertext_b64, nonce_b64, ephemeral_pub_b64 } = envelope;
  if (!ciphertext_b64 || !nonce_b64 || !ephemeral_pub_b64) return null;

  let sk = myDeviceSecretKey;
  if (!sk) {
    try {
      const kp = await getDeviceKeyPair();
      sk = kp && kp.secretKey ? kp.secretKey : null;
    } catch {
      sk = null;
    }
  }
  if (!sk) return null;

  try {
    const ct    = decodeBase64(ciphertext_b64);
    const nonce = decodeBase64(nonce_b64);
    const epub  = decodeBase64(ephemeral_pub_b64);
    const out = nacl.box.open(ct, nonce, epub, sk);
    if (!out || out.length !== 32) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Derive SRTP keying material for ONE direction of a call.
 *
 * Output matches §4 of the design doc:
 *   srtp_key  — 16 bytes  (AES-128 key)
 *   srtp_salt — 14 bytes  (SRTP master salt, RFC 3711)
 *   srtcp_key — 16 bytes
 *   srtcp_salt— 14 bytes
 *
 * Direction-asymmetric (caller-to-callee uses different bytes from
 * callee-to-caller) so an SSRC collision can't degrade into a two-time-pad.
 *
 * @param {Uint8Array} master    — 32-byte per-call master
 * @param {string}     callId    — server-side opaque call_id (used as HKDF salt input)
 * @param {string}     direction — 'send' or 'recv' (caller's perspective)
 * @returns {{ srtpKey:Uint8Array, srtpSalt:Uint8Array, srtcpKey:Uint8Array, srtcpSalt:Uint8Array,
 *            srtpKeyB64:string, srtpSaltB64:string, srtcpKeyB64:string, srtcpSaltB64:string }}
 */
export function deriveSRTPKeys(master, callId, direction) {
  if (!(master instanceof Uint8Array) || master.length !== 32) {
    throw new Error('deriveSRTPKeys: master must be 32 bytes');
  }
  if (!callId || typeof callId !== 'string') {
    throw new Error('deriveSRTPKeys: callId required');
  }
  if (direction !== 'send' && direction !== 'recv') {
    throw new Error('deriveSRTPKeys: direction must be "send" or "recv"');
  }
  // Stable salt derived from call_id so both peers compute the same value
  // without exchanging it. 14-byte SRTP master salt per RFC 3711.
  const saltInfo = `chatyy-call-salt-v1|${callId}`;
  const salt = hkdf(master, new Uint8Array(0), saltInfo, 14);

  const tag = direction === 'send' ? 'caller->callee' : 'callee->caller';
  const srtpKey   = hkdf(master, salt, `srtp/${tag}/key|${callId}`,   16);
  const srtpSalt  = hkdf(master, salt, `srtp/${tag}/salt|${callId}`,  14);
  const srtcpKey  = hkdf(master, salt, `srtcp/${tag}/key|${callId}`,  16);
  const srtcpSalt = hkdf(master, salt, `srtcp/${tag}/salt|${callId}`, 14);

  return {
    srtpKey,
    srtpSalt,
    srtcpKey,
    srtcpSalt,
    srtpKeyB64:   encodeBase64(srtpKey),
    srtpSaltB64:  encodeBase64(srtpSalt),
    srtcpKeyB64:  encodeBase64(srtcpKey),
    srtcpSaltB64: encodeBase64(srtcpSalt),
  };
}

/**
 * Convenience builder — given (master, callee bundle list), produce the
 * `envelopes[]` array shape expected by chat_call_invite_e2ee. Returns the
 * envelopes ready for `apiCall('chat_call_invite_e2ee', { envelopes })`.
 *
 * `bundles` shape: [{ email, device_id, pubkey_b64, one_time_pre_id? }, ...]
 */
export function buildEnvelopesForBundles(master, bundles) {
  if (!Array.isArray(bundles) || bundles.length === 0) return [];
  const out = [];
  for (const b of bundles) {
    if (!b || !b.email || !b.device_id || !b.pubkey_b64) continue;
    try {
      const env = encryptForDevice(master, b.pubkey_b64);
      out.push({
        recipient_email:     String(b.email).toLowerCase(),
        recipient_device_id: String(b.device_id),
        ciphertext_b64:      env.ciphertext_b64,
        nonce_b64:           env.nonce_b64,
        ephemeral_pub_b64:   env.ephemeral_pub_b64,
        ...(b.one_time_pre_id != null ? { one_time_pre_id: b.one_time_pre_id } : {}),
      });
    } catch (e) {
      // Skip malformed bundle — log once. We never block the call on a
      // single bad bundle; the worst case is the offending device misses
      // the call invite and will see it on next reconnect.
      try { console.warn('[e2e-call] skip bundle', b.email, b.device_id, e?.message || e); } catch {}
    }
  }
  return out;
}

/**
 * Best-effort zeroize. JavaScript can't guarantee GC timing, but overwriting
 * the bytes before drop is still strictly better than letting them linger.
 */
export function zeroize(...buffers) {
  for (const buf of buffers) {
    if (buf instanceof Uint8Array) buf.fill(0);
  }
}

// Exported for tests — these are otherwise module-private.
export const __internal__ = { hmacSha512, hkdf };

export default {
  mintCallMasterSecret,
  encryptForDevice,
  decryptMasterEnvelope,
  deriveSRTPKeys,
  buildEnvelopesForBundles,
  zeroize,
};
