/**
 * services/callE2ee.js — Per-call symmetric key: generation + envelope
 * distribution (caller) and envelope receipt/unwrap (callee).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *   The JS layer that gives a 1:1 (or small group) call a single random
 *   32-byte symmetric key, shared ONLY between the participants, so the
 *   media can be end-to-end encrypted (the native frame-cryptor on mobile,
 *   the LiveKit Room `e2ee` option on web — both consume the key bytes).
 *
 *   The key is distributed the SAME way chat messages are: one nacl.box
 *   (X25519 + XSalsa20-Poly1305) "envelope" per recipient DEVICE, shipped
 *   over the already-E2EE per-device envelope channel. We do NOT invent a
 *   new transport — we reuse:
 *     • services/e2e-call.js     → mint / wrap-per-device / unwrap helpers
 *       (these mirror services/envelope.js's per-device nacl.box pattern,
 *        but for a raw 32-byte key instead of a text body).
 *     • services/api.js          → chatCallInviteE2ee (the existing
 *       `chat_call_invite_e2ee` envelope endpoint), chatCallKeyAck,
 *       chatConvDeviceKeys (per-device pubkey lookup).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GATING — this module does NOTHING on its own. It is only ever reached when
 * constants/featureFlags.js `CALL_E2EE_ENABLED === true`. app/call.js
 * lazy-requires it behind that flag. With the flag OFF (production today),
 * none of this code runs and the call behaves exactly as before.
 *
 * The backend ALSO gates with its own CALL_E2EE_ENABLED env: even if a
 * client forces the path on, the server returns 501/no-op until the backend
 * flag is flipped too — so flipping the JS flag alone cannot change live
 * behavior.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PUBLIC API
 *   generateCallKey(callId)                  → Uint8Array(32)   [caller]
 *   distributeCallKey(callId, key, opts)     → Promise<boolean> [caller]
 *   deliverCallKeyEnvelope(callId, envelope) → Promise<bool>    [callee, WS]
 *   getOrAwaitCallKey(callId, peers, opts)   → Promise<string|null>
 *       Caller: generate + distribute, resolves with key (base64) immediately.
 *       Callee: await the envelope (delivered via deliverCallKeyEnvelope),
 *               unwrap, resolve with key (base64). Resolves null on timeout
 *               so the caller falls back to DTLS-SRTP (call never blocks).
 *
 * No new crypto deps — everything rides tweetnacl (already a project dep)
 * through services/e2e-call.js.
 */

import { encodeBase64 } from 'tweetnacl-util';

// ─── Lazy module loaders ─────────────────────────────────────────────────
// We require() lazily so that a build which never flips CALL_E2EE_ENABLED
// never pays the cost of loading the crypto stack, and so a require failure
// (older bundle missing a helper) degrades to "no e2ee" instead of crashing
// the call.
let _ec = undefined;   // services/e2e-call
let _e2e = undefined;  // services/e2e
let _api = undefined;  // services/api

function _loadEc() {
  if (_ec === undefined) {
    try { _ec = require('./e2e-call'); } catch (e) {
      console.warn('[callE2ee] e2e-call unavailable:', e?.message || e);
      _ec = null;
    }
  }
  return _ec || null;
}
function _loadE2e() {
  if (_e2e === undefined) {
    try { _e2e = require('./e2e'); } catch { _e2e = null; }
  }
  return _e2e || null;
}
function _loadApi() {
  if (_api === undefined) {
    try { _api = require('./api'); } catch { _api = null; }
  }
  return _api || null;
}

// ─── Per-call key store ──────────────────────────────────────────────────
// Process-memory only — NEVER persisted to disk. Keyed by callId. We also
// mirror into globalThis.__callMasterSecrets so we interop with the existing
// services/voipNative.js native-outgoing path (which caches the same master
// there for local SRTP derivation). Cleared on endCall().
const _keys = new Map();        // callId -> Uint8Array(32)
const _waiters = new Map();     // callId -> { promise, resolve, timer }

function _globalSecrets() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    if (!g.__callMasterSecrets) g.__callMasterSecrets = new Map();
    return g.__callMasterSecrets;
  } catch { return null; }
}

function _cacheKey(callId, key) {
  const id = String(callId || '');
  if (!id || !(key instanceof Uint8Array) || key.length !== 32) return;
  _keys.set(id, key);
  const gs = _globalSecrets();
  if (gs) { try { gs.set(id, key); } catch {} }
}

function _lookupKey(callId) {
  const id = String(callId || '');
  if (_keys.has(id)) return _keys.get(id);
  const gs = _globalSecrets();
  if (gs && gs.has(id)) {
    const k = gs.get(id);
    if (k instanceof Uint8Array && k.length === 32) { _keys.set(id, k); return k; }
  }
  return null;
}

function _b64(key) {
  try { return key instanceof Uint8Array ? encodeBase64(key) : null; } catch { return null; }
}

// ─── Caller: generate ────────────────────────────────────────────────────
/**
 * Mint a fresh 32-byte symmetric key for `callId` (idempotent — returns the
 * already-cached key if one exists, so a reconnect/retry doesn't rotate the
 * key mid-call). The bytes come from tweetnacl's CSPRNG via e2e-call.
 *
 * @returns {Uint8Array|null} 32-byte key, or null if the crypto stack failed.
 */
export function generateCallKey(callId) {
  const existing = _lookupKey(callId);
  if (existing) return existing;
  const ec = _loadEc();
  if (!ec || typeof ec.mintCallMasterSecret !== 'function') return null;
  let key;
  try { key = ec.mintCallMasterSecret(); } catch (e) {
    console.warn('[callE2ee] mint failed:', e?.message || e);
    return null;
  }
  if (!(key instanceof Uint8Array) || key.length !== 32) return null;
  _cacheKey(callId, key);
  return key;
}

// ─── Caller: distribute ──────────────────────────────────────────────────
/**
 * Wrap `key` once per recipient device and ship the envelopes through the
 * existing `chat_call_invite_e2ee` endpoint. Best-effort: a failure here
 * MUST NOT block the call (the caller still has the key locally; the call
 * degrades to DTLS-SRTP if the callee never gets it).
 *
 * @param {string}      callId
 * @param {Uint8Array}  key
 * @param {object}      opts
 * @param {string|number} opts.conversationId — used to resolve device bundles
 * @returns {Promise<boolean>} true if the envelope POST reported success.
 */
export async function distributeCallKey(callId, key, opts = {}) {
  const ec = _loadEc();
  const e2e = _loadE2e();
  const api = _loadApi();
  if (!ec || !e2e || !api) return false;
  if (!(key instanceof Uint8Array) || key.length !== 32) return false;

  const conversationId = opts.conversationId;
  if (!conversationId) {
    console.warn('[callE2ee] distribute: no conversationId — cannot resolve device bundles');
    return false;
  }
  try {
    // Resolve every member-device {email, device_id, pubkey} tuple for the
    // conversation (includes our own paired devices — perfect fan-out).
    let devices = [];
    if (typeof api.getRecipientDeviceKeys === 'function') {
      devices = await api.getRecipientDeviceKeys(conversationId);
    } else {
      const resp = await api.chatConvDeviceKeys(conversationId);
      const list = resp?.data?.devices || resp?.devices || [];
      devices = Array.isArray(list) ? list : [];
    }
    if (!Array.isArray(devices) || devices.length === 0) {
      console.warn('[callE2ee] distribute: no device bundles for conv', conversationId);
      return false;
    }
    const bundles = devices
      .filter((d) => d && d.email && d.device_id && (d.pubkey || d.pubkey_b64))
      .map((d) => ({
        email:      d.email,
        device_id:  d.device_id,
        pubkey_b64: d.pubkey_b64 || d.pubkey,
      }));
    const envelopes = ec.buildEnvelopesForBundles(key, bundles);
    if (!Array.isArray(envelopes) || envelopes.length === 0) return false;

    const callerDeviceId = await e2e.getDeviceId();
    const r = await api.chatCallInviteE2ee({
      callId,
      callerDeviceId,
      envelopes,
      // sdp_fingerprint is bound by the native layer in a later patch.
      sdpFingerprint: '',
    });
    const ok = !!(r && (r.success || r?.data?.stored));
    try { console.log('[callE2ee] distribute', { callId: String(callId), devices: bundles.length, ok }); } catch {}
    return ok;
  } catch (e) {
    console.warn('[callE2ee] distribute failed (non-fatal):', e?.message || e);
    return false;
  }
}

// ─── Callee: receive + unwrap ────────────────────────────────────────────
/**
 * Called by the WS layer (or a poll) when a `call_e2ee_envelope_ready`
 * arrives for THIS device. Unwraps the master with this device's secret key,
 * caches it, acks the server (replay defense), and resolves any in-flight
 * getOrAwaitCallKey() waiter.
 *
 * NOTE: wiring the WS event → this function lives OUTSIDE this module's
 * scope (services/websocket.js). Until that bridge exists, the callee path
 * resolves null on timeout (call still connects, just DTLS-SRTP). This is
 * documented as a known QA gap before flipping the flag.
 *
 * @param {string} callId
 * @param {{ ciphertext_b64, nonce_b64, ephemeral_pub_b64 }} envelope
 * @returns {Promise<boolean>} true if a key was recovered + cached.
 */
export async function deliverCallKeyEnvelope(callId, envelope) {
  const ec = _loadEc();
  if (!ec || typeof ec.decryptMasterEnvelope !== 'function') return false;
  let key = null;
  try {
    key = await ec.decryptMasterEnvelope(envelope);
  } catch (e) {
    console.warn('[callE2ee] unwrap failed:', e?.message || e);
    return false;
  }
  if (!(key instanceof Uint8Array) || key.length !== 32) return false;

  _cacheKey(callId, key);

  // Ack so the server deletes the stored envelope (replay defense).
  try {
    const api = _loadApi();
    const e2e = _loadE2e();
    if (api && e2e && typeof api.chatCallKeyAck === 'function') {
      const deviceId = await e2e.getDeviceId();
      api.chatCallKeyAck({ callId, deviceId }).catch(() => {});
    }
  } catch {}

  // Resolve any in-flight waiter.
  const id = String(callId || '');
  const w = _waiters.get(id);
  if (w) {
    try { if (w.timer) clearTimeout(w.timer); } catch {}
    _waiters.delete(id);
    try { w.resolve(key); } catch {}
  }
  return true;
}

// Register a global bridge so the WS dispatcher can deliver without a static
// import cycle: globalThis.__chatyyCallKeyDeliver(callId, envelope).
try {
  const g = typeof globalThis !== 'undefined' ? globalThis : global;
  if (g) g.__chatyyCallKeyDeliver = deliverCallKeyEnvelope;
} catch {}

// ─── Orchestrator ────────────────────────────────────────────────────────
/**
 * Resolve the per-call key as a base64 string, ready to hand to the native
 * frame-cryptor (ExpoCallKit.setCallE2EEKey) or the web LiveKit Room `e2ee`
 * key provider.
 *
 * @param {string} callId
 * @param {string[]} peers — peer emails (advisory; bundle resolution uses
 *                           conversationId). Empty array is fine.
 * @param {object} opts
 * @param {boolean} opts.isCaller
 * @param {string|number} opts.conversationId
 * @param {number} [opts.timeoutMs=6000] — callee wait ceiling.
 * @returns {Promise<string|null>} base64 key, or null (→ fall back to SRTP).
 */
export async function getOrAwaitCallKey(callId, peers, opts = {}) {
  const id = String(callId || '');
  if (!id) return null;

  // Already have it (cached from a prior step / native path)?
  const cached = _lookupKey(id);
  if (cached) return _b64(cached);

  const isCaller = !!opts.isCaller;

  if (isCaller) {
    const key = generateCallKey(id);
    if (!key) return null;
    // Fire-and-forget distribution — the caller already holds the key, so a
    // slow/failed POST must not delay the local Room connect.
    try { distributeCallKey(id, key, { conversationId: opts.conversationId }); } catch {}
    return _b64(key);
  }

  // Callee: wait for deliverCallKeyEnvelope() to land the key.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000;
  let existing = _waiters.get(id);
  if (!existing) {
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const timer = setTimeout(() => {
      if (_waiters.get(id)) {
        _waiters.delete(id);
        try { console.warn('[callE2ee] callee key wait timed out — falling back to SRTP', id); } catch {}
        try { resolveFn(null); } catch {}
      }
    }, timeoutMs);
    existing = { promise, resolve: resolveFn, timer };
    _waiters.set(id, existing);
  }
  const key = await existing.promise;
  return key instanceof Uint8Array ? _b64(key) : null;
}

// ─── Teardown ────────────────────────────────────────────────────────────
/**
 * Best-effort zeroize + drop the key for `callId` (call to clear on
 * call_end). Safe to call when nothing is cached.
 */
export function endCall(callId) {
  const id = String(callId || '');
  const key = _keys.get(id);
  if (key instanceof Uint8Array) {
    try { for (let i = 0; i < key.length; i++) key[i] = 0; } catch {}
  }
  _keys.delete(id);
  const gs = _globalSecrets();
  if (gs) { try { gs.delete(id); } catch {} }
  const w = _waiters.get(id);
  if (w) {
    try { if (w.timer) clearTimeout(w.timer); } catch {}
    try { w.resolve(null); } catch {}
    _waiters.delete(id);
  }
}

export default {
  generateCallKey,
  distributeCallKey,
  deliverCallKeyEnvelope,
  getOrAwaitCallKey,
  endCall,
};
