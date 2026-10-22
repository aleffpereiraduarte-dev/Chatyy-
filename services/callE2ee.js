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
import { Platform } from 'react-native';

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

// ════════════════════════════════════════════════════════════════════════════
// [e2ee5 WP-13 2026-10-21] LIGAÇÕES E2EE v5 (contrato docs/e2ee/CONTRATO.md §3)
// ════════════════════════════════════════════════════════════════════════════
// Substitui o caminho legado acima (nacl.box por aparelho + chat_call_invite_e2ee, nunca
// ligado) quando — e SÓ quando — as DUAS chaves estão ligadas:
//   1. `globalThis.__chatyy_e2ee5 === true` (OTA, desligada por padrão);
//   2. `e2ee5_status.flags.e2ee5_calls === true` (servidor: E2EE5_FLAGS=calls + allowlist).
// E a ligação só é cifrada se a CONVERSA está em `e2ee_mode=1`. Fora disso todas as funções
// abaixo devolvem "não exigido" sem tocar rede/núcleo/nativo → ligação idêntica à de hoje.
//
// Modelo (PLANO §2.7):
//   - quem liga gera uma chave aleatória de 32 B e manda `chatyy.call_key` {v,call_id,conv_id,
//     key,index,ts} por to-device Olm (núcleo chatyy-crypto) para os aparelhos ASSINADOS dos
//     membros. O servidor só vê ciphertext Olm.
//   - LiveKit E2EE (frame encryption, AES-GCM) com a chave como "shared key" em TEXTO base64 nos
//     3 clientes (iOS BaseKeyProvider.setKey(key:), Android setSharedKey(String), web
//     ExternalE2EEKeyProvider.setKey(string)) → mesmo PBKDF2 (sal LKFrameEncryptionKey) nos 3.
//   - rotação (grupo): o líder (quem ligou; se saiu, o menor identity presente) gera index+1 a
//     cada entrada/saída e manda só para quem está na sala. O slot do LiveKit é sempre 0 (o
//     nativo não troca o keyIndex do cifrador) → ~0,3–1 s de quadros descartados na troca.
//   - SEM chave = sem mídia (o cifrador descarta os quadros); NUNCA cai para texto claro.
//   - P2P 1:1: oferta/resposta SDP vão por `chatyy.call_sdp` (autenticadas: o fingerprint DTLS
//     não pode ser trocado pelo hub); o hub recebe um stub "v=0" só para manter a rota.
// Logs: só ids/tamanhos/códigos/tempos — nunca chave, SDP ou bearer.

const E5_KEY = 'chatyy.call_key';
const E5_SDP = 'chatyy.call_sdp';
const E5_TTL_MS = 10 * 60 * 1000;      // chave recebida antes da ligação existir
const E5_MAX_CALLS = 64;
const E5_ROTATE_DEBOUNCE_MS = 400;
export const E5_SDP_STUB = 'v=0\r\ns=chatyy-e2ee5\r\n';

const _e5calls = new Map();   // callId → ctx
const _e5sdp = new Map();     // `${callId}|${kind}|${gen}` → {sdp, senderUid, at}
const _e5sdpWait = new Map(); // mesma chave → [resolve]
const _e5m = { sent: 0, sendFail: 0, recv: 0, rejected: 0, rotations: 0, sdpSent: 0, sdpRecv: 0, lastSendMs: 0, lastKeyWaitMs: 0 };
let _e5listen = null;
let _e5drainTimer = null;

function _e5g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _e5flag() { try { return _e5g().__chatyy_e2ee5 === true; } catch { return false; } }
function _e5mod() { try { return require('./e2ee/e2ee5'); } catch { return null; } }
function _e5C() { try { return require('./crypto'); } catch { return null; } }
function _e5native() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { return require('../modules/expo-callkit'); } catch { return null; }
}
function _e5log(what, kv) {
  try { if (_e5g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5.call] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch {}
}
const _e5canon = (e) => {
  const s = String(e || '').trim().toLowerCase();
  return s.endsWith('@onemundo.com.br') ? s.slice(0, -16) + '@chatyy.com.br' : s;
};
/** identity do LiveKit = `email#sufixo-do-aparelho` → e-mail canônico. */
export function e2ee5IdentityEmail(identity) { return _e5canon(String(identity || '').split('#')[0]); }

function _e5sess() { const m = _e5mod(); try { return (m && m.sessionSync && m.sessionSync()) || null; } catch { return null; } }
function _e5myUid() { const s = _e5sess(); return s ? String(s.uid || '') : ''; }
function _e5callsFlag() {
  const s = _e5sess();
  return !!(s && s.status && s.status.flags && s.status.flags.e2ee5_calls === true);
}

/** As duas chaves (JS + servidor) ligadas e sessão do núcleo aberta. Síncrono, barato. */
export function e2ee5CallsOn() { return _e5flag() && _e5callsFlag(); }

function _e5rand32() {
  const u8 = new Uint8Array(32);
  const g = _e5g();
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') { g.crypto.getRandomValues(u8); return u8; }
  try { require('expo-crypto').getRandomValues(u8); return u8; } catch {}
  // Sem CSPRNG = sem chave (nunca Math.random).
  throw Object.assign(new Error('e2ee5:no_csprng'), { code: 'no_csprng' });
}
function _e5b64ok(k) {
  if (typeof k !== 'string' || k.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(k)) return false;
  return true; // 44 chars base64 com 1 '=' ⇔ 32 bytes
}

function _e5ctx(callId, create) {
  const id = String(callId || '');
  if (!id) return null;
  let c = _e5calls.get(id);
  if (!c && create) {
    if (_e5calls.size >= E5_MAX_CALLS) {
      // descarta o mais velho
      let oldK = null; let oldT = Infinity;
      for (const [k, v] of _e5calls) if (v.updatedAt < oldT) { oldT = v.updatedAt; oldK = k; }
      if (oldK) _e5calls.delete(oldK);
    }
    c = { callId: id, convId: '', required: false, isGroup: false, initiator: false, keyB64: null, index: -1,
      keyFrom: '', listeners: new Set(), waiters: [], createdAt: Date.now(), updatedAt: Date.now(),
      peerUid: '', inRoom: new Set(), leader: false, rotTimer: null, leaderEmail: '', warn: null };
    _e5calls.set(id, c);
  }
  return c || null;
}

function _e5gc() {
  const now = Date.now();
  for (const [k, c] of _e5calls) {
    if (!c.required && !c.keyB64 && now - c.updatedAt > E5_TTL_MS) _e5calls.delete(k);
    else if (c.keyB64 && !c.required && now - c.updatedAt > E5_TTL_MS) _e5calls.delete(k); // chave nunca usada
  }
  for (const [k, v] of _e5sdp) if (now - v.at > 60000) _e5sdp.delete(k);
}

// ───── ponte nativa (iOS/Android). Binário sem os métodos = sem suporte nativo. ─────
/** Versão da API E2EE de ligação do binário (0 = este build não sabe cifrar ligação nativa). */
export function e2ee5NativeCaps() {
  const n = _e5native();
  try { return n && typeof n.callE2EECaps === 'function' ? Number(n.callE2EECaps()) || 0 : 0; } catch { return 0; }
}
function _e5nativeRequire(callId, on) {
  const n = _e5native();
  try { if (n && typeof n.setCallE2EERequired === 'function') n.setCallE2EERequired(String(callId), !!on); } catch {}
}
function _e5nativeKey(callId, keyB64) {
  const n = _e5native();
  try { if (n && typeof n.setCallE2EEKey === 'function') n.setCallE2EEKey(String(callId), String(keyB64)); } catch {}
}
function _e5nativeStatus(callId) {
  const n = _e5native();
  try { return n && typeof n.callE2EEStatus === 'function' ? (n.callE2EEStatus(String(callId)) || null) : null; } catch { return null; }
}
function _e5nativeHint(convId, peerEmail) {
  const n = _e5native();
  try { if (n && typeof n.setCallE2EEConvHint === 'function') n.setCallE2EEConvHint(String(convId), _e5canon(peerEmail || ''), true); } catch {}
}
function _e5nativeClear(callId) {
  const n = _e5native();
  try { if (n && typeof n.clearCallE2EE === 'function') n.clearCallE2EE(String(callId)); } catch {}
}

function _e5emitKey(c) {
  const ev = { callId: c.callId, keyB64: c.keyB64, index: c.index };
  for (const cb of Array.from(c.listeners)) { try { cb(ev); } catch {} }
  const w = c.waiters.splice(0);
  for (const r of w) { try { r(ev); } catch {} }
}

function _e5setKey(c, keyB64, index, from) {
  c.keyB64 = keyB64;
  c.index = index;
  c.keyFrom = from || '';
  c.updatedAt = Date.now();
  _e5nativeKey(c.callId, keyB64);
  _e5emitKey(c);
}

// ───── política ─────
/**
 * A ligação desta conversa TEM de ser cifrada? → `{required, reason, convState}`.
 * reason: 'flag_off' | 'calls_off' | 'no_conv' | 'not_e2ee' | 'e2ee' | 'no_session' (cifrada sem sessão = bloquear).
 */
export async function e2ee5Policy({ convId } = {}) {
  if (!_e5flag()) return { required: false, reason: 'flag_off' };
  const m = _e5mod();
  if (!m) return { required: false, reason: 'flag_off' };
  if (convId == null || convId === '') return { required: false, reason: 'no_conv' };
  let sess = null;
  try {
    sess = await Promise.race([m.ensureSession(), new Promise((r) => setTimeout(() => r(null), 5000))]);
  } catch { sess = null; }
  const cachedMode = (() => { try { return m.convModeSync(convId); } catch { return null; } })();
  if (!sess) {
    // Sem núcleo não dá para cifrar. Conversa sabidamente cifrada = não liga em claro.
    return cachedMode === 1 ? { required: true, reason: 'no_session' } : { required: false, reason: 'no_session' };
  }
  if (!_e5callsFlag()) return { required: false, reason: 'calls_off' };
  let st = null;
  try { st = await m.convState(convId); } catch { st = null; }
  if (!st) return cachedMode === 1 ? { required: true, reason: 'e2ee' } : { required: false, reason: 'not_e2ee' };
  return st.mode === 1 ? { required: true, reason: 'e2ee', convState: st } : { required: false, reason: 'not_e2ee', convState: st };
}

function _e5members(st) {
  const me = _e5myUid();
  return (st && Array.isArray(st.members) ? st.members : []).map(String).filter((u) => u && u !== me);
}
function _e5emailToUid(convId, email) {
  const m = _e5mod();
  const st = (() => { try { return m && m.convStateSync(convId); } catch { return null; } })();
  const e = _e5canon(email);
  for (const x of (st && Array.isArray(st.capable) ? st.capable : [])) {
    if (x && x.uid != null && x.email && _e5canon(x.email) === e) return String(x.uid);
  }
  return '';
}

function _e5uidToEmail(convId, uid) {
  const m = _e5mod();
  const st = (() => { try { return m && m.convStateSync(convId); } catch { return null; } })();
  for (const x of (st && Array.isArray(st.capable) ? st.capable : [])) {
    if (x && x.uid != null && String(x.uid) === String(uid) && x.email) return _e5canon(x.email);
  }
  return '';
}

async function _e5send(c, targetUids, why) {
  const C = _e5C();
  if (!C || !c.keyB64) return { ok: false, sent: 0 };
  const targets = Array.from(new Set(targetUids.map(String).filter(Boolean))).map((uid) => ({ uid, deviceId: '' }));
  if (!targets.length) return { ok: true, sent: 0 };
  const content = { v: 1, call_id: c.callId, conv_id: String(c.convId), key: c.keyB64, index: c.index >>> 0, ts: Date.now() };
  const t0 = Date.now();
  try {
    const r = await C.sendToDevice(E5_KEY, targets, content);
    const ms = Date.now() - t0;
    _e5m.sent += 1; _e5m.lastSendMs = ms;
    const sent = Number(r && r.sentDevices) || (Array.isArray(r && r.sentDevices) ? r.sentDevices.length : 0);
    _e5log('key_sent', { call: c.callId, why, idx: c.index, users: targets.length, devices: sent, withheld: (r && r.withheld && r.withheld.length) || 0, ms });
    return { ok: true, sent, ms };
  } catch (e) {
    _e5m.sendFail += 1;
    _e5log('key_send_fail', { call: c.callId, why, code: e && e.code });
    return { ok: false, sent: 0, code: e && e.code };
  }
}

// ───── quem liga ─────
/**
 * Início da ligação (iniciador). Gera a chave, entrega ao nativo e distribui em 2º plano.
 * → `{required:false}` (ligação de hoje) | `{required:true, keyB64, index, distributed: Promise}` |
 *   `{required:true, blocked:'no_session'|'no_csprng'|'native_unsupported'}` (NÃO ligar em claro).
 * `needsNative`: a mídia vai pelo LiveKit NATIVO (CallViewController/CallActivity).
 */
export async function e2ee5BeginCall({ callId, convId, isGroup, needsNative } = {}) {
  const pol = await e2ee5Policy({ convId });
  if (!pol.required) return { required: false, reason: pol.reason };
  if (pol.reason === 'no_session') return { required: true, blocked: 'no_session' };
  if (needsNative && e2ee5NativeCaps() < 1) return { required: true, blocked: 'native_unsupported' };
  const c = _e5ctx(callId, true);
  if (!c) return { required: true, blocked: 'bad_call' };
  if (c.initiator && c.keyB64 && c.convId === String(convId)) {
    // idempotente (voipNative → call.js na mesma ligação): não redistribui
    return { required: true, keyB64: c.keyB64, index: c.index, distributed: Promise.resolve({ ok: true, sent: 0, again: true }) };
  }
  c.convId = String(convId); c.required = true; c.isGroup = !!isGroup; c.initiator = true; c.leader = true;
  _e5nativeRequire(c.callId, true);
  _e5wireNativeRoom();
  _e5armDrain();
  if (!c.keyB64) {
    let k;
    try { k = encodeBase64(_e5rand32()); } catch (e) { return { required: true, blocked: 'no_csprng' }; }
    _e5setKey(c, k, 0, 'self');
  }
  const targets = _e5members(pol.convState);
  const distributed = _e5send(c, targets, 'begin');
  return { required: true, keyB64: c.keyB64, index: c.index, distributed };
}

// ───── quem recebe ─────
/**
 * Ligação recebida/entrando: decide se é cifrada e marca no nativo ANTES do Room existir
 * (o nativo cria o Room com E2EE e sem chave = quadros descartados até a chave chegar).
 * → `{required, keyB64?, index?, blocked?}`.
 */
export async function e2ee5PrepareJoin({ callId, convId, isGroup, needsNative } = {}) {
  let pol = await e2ee5Policy({ convId });
  if (!pol.required) {
    // [e2ee5 WP-07/WP-13 2026-10-22] Fail closed: o convite/push disse "conversa cifrada" ("e2ee":"5")
    // ou o nativo já marcou a ligação como exigida (dica do servidor/local no toque com o app fechado)
    // → NÃO entra em claro, mesmo que a política local ainda não saiba (núcleo frio, estado sem cache).
    const pre = _e5ctx(callId, false);
    const nat = _e5nativeStatus(callId);
    if ((pre && pre.serverHint) || (nat && nat.required === true)) {
      pol = { required: true, reason: _e5flag() && _e5sess() ? 'hint' : 'no_session' };
    } else {
      return { required: false, reason: pol.reason };
    }
  }
  const c = _e5ctx(callId, true);
  if (!c) return { required: true, blocked: 'bad_call' };
  if (c.convId && c.convId !== String(convId) && !c.initiator) {
    // chave chegou antes amarrada a OUTRA conversa: descarta (só vale a do convite)
    c.keyB64 = null; c.index = -1; c.keyFrom = '';
    _e5nativeClear(c.callId);
  }
  c.convId = String(convId); c.required = true; c.isGroup = !!isGroup;
  _e5nativeRequire(c.callId, true);
  if (pol.reason === 'no_session') return { required: true, blocked: 'no_session' };
  if (needsNative && e2ee5NativeCaps() < 1) return { required: true, blocked: 'native_unsupported' };
  _e5wireNativeRoom();
  _e5armDrain();
  if (!c.keyB64) { try { _e5mod()?.requestSync?.(0); } catch {} }
  return { required: true, keyB64: c.keyB64 || null, index: c.index };
}

/**
 * [e2ee5 WP-07/WP-13 2026-10-22] Convite/push de ligação recebido com a dica do servidor
 * (`e2ee: "5"` = a conversa tem e2ee_mode=1). Marca a ligação como EXIGIDA no JS e no nativo ANTES
 * de qualquer Room (o nativo cria o Room com E2EE; sem chave = sem mídia) e grava a dica da conversa
 * para o próximo toque com o app fechado. O servidor só LIGA a exigência; sem a dica não muda nada.
 * → true se marcou.
 */
export function e2ee5NoteInvite({ callId, convId, callerEmail, hint } = {}) {
  const h = parseInt(String(hint == null ? '' : hint), 10);
  if (!(h >= 5)) return false;
  const c = _e5ctx(callId, true);
  if (!c) return false;
  c.serverHint = true;
  c.required = true;
  if (convId != null && convId !== '' && !c.convId) c.convId = String(convId);
  c.updatedAt = Date.now();
  _e5nativeRequire(c.callId, true);
  if (convId != null && convId !== '') _e5nativeHint(convId, callerEmail);
  _e5log('invite_hint', { call: c.callId });
  return true;
}

/** Espera a chave desta ligação. → `{keyB64, index}` ou null (timeout). */
export function e2ee5AwaitKey(callId, timeoutMs = 15000) {
  const c = _e5ctx(callId, true);
  if (!c) return Promise.resolve(null);
  if (c.keyB64) return Promise.resolve({ callId: c.callId, keyB64: c.keyB64, index: c.index });
  _e5armDrain();
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; _e5m.lastKeyWaitMs = Date.now() - t0; resolve(v); };
    c.waiters.push(fin);
    setTimeout(() => { const i = c.waiters.indexOf(fin); if (i >= 0) c.waiters.splice(i, 1); fin(null); }, Math.max(500, Number(timeoutMs) || 15000));
  });
}

/** Avisa a cada chave nova (rotação). → função para cancelar. */
export function e2ee5OnKey(callId, cb) {
  const c = _e5ctx(callId, true);
  if (!c || typeof cb !== 'function') return () => {};
  c.listeners.add(cb);
  return () => { try { c.listeners.delete(cb); } catch {} };
}

export function e2ee5Status(callId) {
  const c = _e5ctx(callId, false);
  if (!c) return { required: false, hasKey: false, index: -1 };
  return { required: !!c.required, hasKey: !!c.keyB64, index: c.index, leader: !!c.leader, warn: c.warn };
}

// ───── rotação (grupo) ─────
async function _e5rotate(c, why) {
  if (!c || !c.required || !c.leader) return;
  let k;
  try { k = encodeBase64(_e5rand32()); } catch { return; }
  const next = (c.index >= 0 ? c.index : 0) + 1;
  // Destino = quem está na sala AGORA (por uid); quem saiu não recebe.
  const uids = [];
  for (const email of c.inRoom) { const u = _e5emailToUid(c.convId, email); if (u) uids.push(u); }
  const me = _e5myUid();
  const prevKey = c.keyB64; const prevIdx = c.index;
  c.keyB64 = k; c.index = next;
  const r = await _e5send(c, uids.filter((u) => u !== me), why);
  if (!r.ok) { c.keyB64 = prevKey; c.index = prevIdx; return; } // não deu para avisar: mantém a anterior
  _e5m.rotations += 1;
  try { const s = _e5sess(); if (s && s.email) c.leaderEmail = _e5canon(s.email); } catch {}
  _e5setKey(c, k, next, 'self');
}

/**
 * A sala mudou (JS Room / eventos onLk* do nativo). `identities` = identities REMOTAS presentes.
 * Só o líder rotaciona: quem ligou (enquanto está na ligação); senão quem mandou a última chave;
 * se esse saiu, o menor e-mail entre os presentes (incl. eu) assume.
 */
export function e2ee5RoomChanged(callId, { selfIdentity, identities } = {}) {
  const c = _e5ctx(callId, false);
  if (!c || !c.required) return;
  const self = e2ee5IdentityEmail(selfIdentity);
  const now = new Set((Array.isArray(identities) ? identities : []).map(e2ee5IdentityEmail).filter((e) => e && e !== self));
  const changed = now.size !== c.inRoom.size || Array.from(now).some((e) => !c.inRoom.has(e));
  c.inRoom = now;
  if (!c.isGroup) return; // 1:1: a chave já é só dos dois
  if (c.initiator) c.leader = true;
  else if (c.leaderEmail && c.leaderEmail !== self && now.has(c.leaderEmail)) c.leader = false;
  else if (self) c.leader = Array.from(now).concat([self]).sort()[0] === self;
  else c.leader = false;
  if (!changed || !c.leader) return;
  if (c.rotTimer) clearTimeout(c.rotTimer);
  c.rotTimer = setTimeout(() => { c.rotTimer = null; _e5rotate(c, 'members'); }, E5_ROTATE_DEBOUNCE_MS);
}

/** Aviso de participante sem cifra (versão antiga) — só UI; a nossa mídia continua cifrada. */
export function e2ee5NoteUnencrypted(callId, identity) {
  const c = _e5ctx(callId, false);
  if (!c || !c.required) return;
  c.warn = { kind: 'unencrypted_peer', email: e2ee5IdentityEmail(identity), at: Date.now() };
  for (const cb of Array.from(c.listeners)) { try { cb({ callId: c.callId, keyB64: c.keyB64, index: c.index, warn: c.warn }); } catch {} }
}

// ───── P2P: SDP autenticado ─────
/** Envia oferta/resposta pelo canal E2EE ao uid do par. → true se saiu. */
export async function e2ee5SendSdp(callId, { kind, sdp, gen, peerUid } = {}) {
  const C = _e5C();
  if (!C || !peerUid || (kind !== 'offer' && kind !== 'answer') || typeof sdp !== 'string') return false;
  try {
    // `gen` = geração da negociação (ICE restart), igual ao call_p2p_* do hub. (Pedido ao WP-00:
    // registrar `gen` no §3 do contrato; `mid`/`mline` seguem reservados para candidato.)
    await C.sendToDevice(E5_SDP, [{ uid: String(peerUid), deviceId: '' }], { v: 1, call_id: String(callId), kind, sdp, gen: Number(gen) || 0 });
    _e5m.sdpSent += 1;
    return true;
  } catch (e) { _e5log('sdp_send_fail', { call: String(callId), code: e && e.code }); return false; }
}
/** Espera a SDP autenticada (kind, gen). → string ou null. */
export function e2ee5TakeSdp(callId, kind, gen, timeoutMs = 6000) {
  const k = String(callId) + '|' + kind + '|' + String(Number(gen) || 0);
  const have = _e5sdp.get(k);
  if (have) { _e5sdp.delete(k); return Promise.resolve(have.sdp); }
  _e5armDrain();
  try { _e5mod()?.requestSync?.(0); } catch {}
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; resolve(v); };
    const arr = _e5sdpWait.get(k) || [];
    arr.push(fin); _e5sdpWait.set(k, arr);
    setTimeout(() => { fin(null); }, Math.max(500, Number(timeoutMs) || 6000));
  });
}

// ───── recepção dos eventos chatyy.call_* (núcleo já decifrou e conferiu a assinatura) ─────
async function _e5senderOk(convId, senderUid) {
  if (!senderUid) return false;
  if (senderUid === _e5myUid()) return true; // outro aparelho MEU (assinado pelo dono — o núcleo garante)
  const m = _e5mod();
  let st = null;
  try { st = m && m.convStateSync(convId); } catch {}
  if (!st || !Array.isArray(st.members) || !st.members.length) { try { st = await m.convState(convId); } catch { st = null; } }
  return !!(st && Array.isArray(st.members) && st.members.map(String).includes(String(senderUid)));
}

/** Um evento `{eventType, senderUid, senderDeviceId, contentJson}`. → true se era de ligação. */
export function e2ee5HandleEvent(ev) {
  if (!ev || typeof ev.eventType !== 'string' || !ev.eventType.startsWith('chatyy.call_')) return false;
  if (!_e5flag()) return true;
  let o = null;
  try { o = JSON.parse(ev.contentJson || '{}'); } catch { o = null; }
  if (!o || o.v !== 1 || typeof o.call_id !== 'string' || !o.call_id || o.call_id.length > 128) { _e5m.rejected += 1; return true; }
  const senderUid = String(ev.senderUid || '');
  if (ev.eventType === E5_KEY) {
    const idx = Number(o.index);
    if (!_e5b64ok(o.key) || !Number.isInteger(idx) || idx < 0 || idx > 0xffffffff || !o.conv_id) { _e5m.rejected += 1; return true; }
    (async () => {
      const ok = await _e5senderOk(String(o.conv_id), senderUid);
      if (!ok) { _e5m.rejected += 1; _e5log('key_reject_sender', { call: o.call_id }); return; }
      const c = _e5ctx(o.call_id, true);
      if (!c) return;
      if (c.convId && c.convId !== String(o.conv_id)) { _e5m.rejected += 1; return; } // chave de outra conversa
      if (c.keyB64 && idx <= c.index) return; // velha/replay
      c.convId = String(o.conv_id);
      _e5m.recv += 1;
      if (senderUid !== _e5myUid()) {
        const le = _e5uidToEmail(c.convId, senderUid);
        if (le) c.leaderEmail = le; // quem mandou a chave mais nova é o líder atual
        if (c.initiator && idx > c.index) c.initiator = false; // outro assumiu (eu tinha saído e voltei)
      }
      _e5log('key_recv', { call: c.callId, idx, waited: c.waiters.length });
      _e5setKey(c, o.key, idx, senderUid);
      _e5gc();
    })().catch(() => {});
    return true;
  }
  if (ev.eventType === E5_SDP) {
    if ((o.kind !== 'offer' && o.kind !== 'answer') || typeof o.sdp !== 'string' || !o.sdp.startsWith('v=0') || o.sdp.length > 64 * 1024) { _e5m.rejected += 1; return true; }
    const c = _e5ctx(o.call_id, false);
    // SDP só do par esperado desta ligação (o uid do outro lado do 1:1).
    if (c && c.peerUid && senderUid !== c.peerUid) { _e5m.rejected += 1; return true; }
    const k = o.call_id + '|' + o.kind + '|' + String(Number(o.gen) || 0);
    _e5m.sdpRecv += 1;
    const w = _e5sdpWait.get(k);
    if (w && w.length) { _e5sdpWait.delete(k); for (const f of w) { try { f(o.sdp); } catch {} } } else _e5sdp.set(k, { sdp: o.sdp, senderUid, at: Date.now() });
    return true;
  }
  return true; // chatyy.call_* desconhecido: ignora
}
try { _e5g().__chatyyE2ee5CallEvent = e2ee5HandleEvent; } catch {}

/** P2P: amarra o uid do par (só ele pode mandar SDP para esta ligação). */
export function e2ee5SetPeer(callId, peerUid) {
  const c = _e5ctx(callId, true);
  if (c && peerUid) c.peerUid = String(peerUid);
}
/** uid do outro membro de um 1:1 (do estado da conversa). */
export function e2ee5PeerUid(convId, peerEmail) {
  const u = peerEmail ? _e5emailToUid(convId, peerEmail) : '';
  if (u) return u;
  const m = _e5mod();
  const st = (() => { try { return m && m.convStateSync(convId); } catch { return null; } })();
  const others = _e5members(st);
  return others.length === 1 ? others[0] : '';
}

// Eventos que o NATIVO consumiu (iOS: onSyncResult source=native; Android: fila e2e_events do
// store, enchida pelo sync em 2º plano). Só enquanto há ligação cifrada esperando/ativa.
function _e5wireNativeEvents() {
  if (_e5listen || !_e5flag()) return;
  const C = _e5C();
  if (!C || typeof C.addListener !== 'function') return;
  try {
    _e5listen = C.addListener('onSyncResult', (r) => {
      if (!r || r.source === 'js' || !Array.isArray(r.chatyyEvents)) return;
      for (const ev of r.chatyyEvents) e2ee5HandleEvent(ev);
    });
  } catch { _e5listen = null; }
}
function _e5activeCount() { let n = 0; for (const c of _e5calls.values()) if (c.required) n++; return n; }
function _e5drainAndroid() {
  if (Platform.OS !== 'android') return;
  const s = _e5sess();
  if (!s || !s.email) return;
  let st = null;
  try { const { requireOptionalNativeModule } = require('expo'); st = requireOptionalNativeModule('ChatyyChatStore'); } catch { st = null; }
  if (!st || typeof st.e2eEventsDrain !== 'function') return;
  let list = [];
  try { list = JSON.parse(st.e2eEventsDrain(String(s.email)) || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return;
  const other = [];
  for (const ev of list) if (!e2ee5HandleEvent(ev)) other.push(ev);
  // Os outros chatyy.* (decrypt_report, link.revoked…) voltam para o caminho normal do WP-08c.
  if (other.length) { try { _e5mod()?.dispatchChatyyEvents?.(other); } catch {} }
}
function _e5armDrain() {
  _e5wireNativeEvents();
  if (Platform.OS !== 'android' || _e5drainTimer) return;
  const tick = () => {
    _e5drainTimer = null;
    try { _e5drainAndroid(); } catch {}
    if (_e5activeCount() > 0) _e5drainTimer = setTimeout(tick, 1000);
  };
  _e5drainTimer = setTimeout(tick, 0);
}

/** Estado da conversa mudou (gancho do WP-08c): grava a dica nativa p/ o toque com o app morto. */
export function e2ee5NoteConv(convId, st) {
  if (!_e5flag() || !st) return;
  const n = _e5native();
  if (!n || typeof n.setCallE2EEConvHint !== 'function') return;
  const on = st.mode === 1 && _e5callsFlag();
  const me = (() => { const s = _e5sess(); return s ? _e5canon(s.email) : ''; })();
  const peers = (Array.isArray(st.capable) ? st.capable : []).map((x) => _e5canon(x && x.email)).filter((e) => e && e !== me);
  try { n.setCallE2EEConvHint(String(convId), on && peers.length === 1 ? peers[0] : '', !!on); } catch {}
}

/** Fim da ligação: esquece chave, SDPs e o estado nativo. */
export function e2ee5End(callId) {
  const id = String(callId || '');
  const c = _e5calls.get(id);
  if (c) {
    if (c.rotTimer) { try { clearTimeout(c.rotTimer); } catch {} }
    const w = c.waiters.splice(0);
    for (const r of w) { try { r(null); } catch {} }
    c.listeners.clear();
    c.keyB64 = null;
    _e5calls.delete(id);
  }
  for (const k of Array.from(_e5sdp.keys())) if (k.startsWith(id + '|')) _e5sdp.delete(k);
  try { _e5nativeRooms.delete(id); } catch {}
  _e5nativeClear(id);
}

/**
 * Opções `e2ee` do Room JS (web: ExternalE2EEKeyProvider + worker; mobile JS: RNE2EEManager).
 * → `{ok:true, e2ee, setKey(keyB64)}` | `{ok:false, why}`. ok:false numa ligação EXIGIDA = não
 * conectar (o chamador mostra `e2ee5.call.unsupported`). Depois do `new Room(opts)`, chame
 * `await room.setE2EEEnabled(true)` ANTES do connect.
 */
export async function e2ee5BuildRoomE2ee({ lk, lkrn } = {}) {
  try {
    if (Platform.OS === 'web') {
      if (!lk || typeof lk.ExternalE2EEKeyProvider !== 'function') return { ok: false, why: 'no_lk' };
      if (typeof lk.isE2EESupported === 'function' && !lk.isE2EESupported()) return { ok: false, why: 'browser' };
      let wm = null;
      try { wm = await import('./lkE2eeWorker'); } catch { wm = null; }
      if (!wm || typeof wm.createLkE2eeWorker !== 'function') return { ok: false, why: 'worker_load' };
      if (lk.version && wm.LK_E2EE_WORKER_VERSION && String(lk.version) !== String(wm.LK_E2EE_WORKER_VERSION)) return { ok: false, why: 'worker_version' };
      const worker = wm.createLkE2eeWorker();
      if (!worker) return { ok: false, why: 'no_worker' };
      const keyProvider = new lk.ExternalE2EEKeyProvider();
      // string → PBKDF2 (mesmo material que o setKey(String) dos SDKs nativos)
      const setKey = (k) => Promise.resolve(keyProvider.setKey(String(k))).catch(() => {});
      return { ok: true, e2ee: { keyProvider, worker }, setKey };
    }
    if (!lkrn || typeof lkrn.RNKeyProvider !== 'function' || typeof lkrn.RNE2EEManager !== 'function') return { ok: false, why: 'no_rn_e2ee' };
    const keyProvider = new lkrn.RNKeyProvider({ sharedKey: true });
    const e2eeManager = new lkrn.RNE2EEManager(keyProvider, false);
    const setKey = (k) => Promise.resolve(keyProvider.setSharedKey(String(k), 0)).catch(() => {});
    return { ok: true, e2ee: { e2eeManager }, setKey, dispose: () => { try { keyProvider.dispose && keyProvider.dispose(); } catch {} } };
  } catch (e) {
    return { ok: false, why: 'error' };
  }
}

/** Texto i18n fora de componente (idioma atual do app; fallback pt-BR). */
export function e2ee5Text(key, fb) {
  try {
    const i18n = require('../i18n');
    const lang = _e5g().__chatyyLang || 'pt-BR';
    const v = i18n.lookupKey ? i18n.lookupKey(lang, key) : null;
    if (typeof v === 'string' && v) return v;
  } catch {}
  return fb || key;
}

// Sala NATIVA (CallViewController/CallActivity/Group*): os eventos onLk* alimentam a rotação
// quando o líder é este aparelho (JS vivo). Instalado na 1ª ligação cifrada.
let _e5nativeRoomWired = false;
const _e5nativeRooms = new Map(); // callId → {self, ids:Set}
function _e5wireNativeRoom() {
  if (_e5nativeRoomWired) return;
  const n = _e5native();
  if (!n || typeof n.onLkEvent !== 'function') return;
  _e5nativeRoomWired = true;
  const cur = (d) => {
    const id = String((d && d.callId) || '');
    if (!id || !_e5calls.has(id)) return null;
    let r = _e5nativeRooms.get(id);
    if (!r) { r = { self: '', ids: new Set() }; _e5nativeRooms.set(id, r); }
    return { id, r };
  };
  const push = (x) => { try { e2ee5RoomChanged(x.id, { selfIdentity: x.r.self, identities: Array.from(x.r.ids) }); } catch {} };
  try {
    n.onLkEvent('onLkConnected', (d) => { const x = cur(d); if (!x) return; if (d.localIdentity) x.r.self = String(d.localIdentity); push(x); });
    n.onLkEvent('onLkParticipantConnected', (d) => { const x = cur(d); if (!x || !d.identity) return; x.r.ids.add(String(d.identity)); push(x); });
    n.onLkEvent('onLkParticipantDisconnected', (d) => { const x = cur(d); if (!x || !d.identity) return; x.r.ids.delete(String(d.identity)); push(x); });
  } catch {}
}

export function e2ee5Metrics() { return { ..._e5m, calls: _e5calls.size }; }

// Testes (node): estado interno.
export function _e5reset() { _e5calls.clear(); _e5sdp.clear(); _e5sdpWait.clear(); for (const k of Object.keys(_e5m)) _e5m[k] = 0; }

export default {
  generateCallKey,
  distributeCallKey,
  deliverCallKeyEnvelope,
  getOrAwaitCallKey,
  endCall,
  // [e2ee5 WP-13]
  e2ee5CallsOn,
  e2ee5Policy,
  e2ee5BeginCall,
  e2ee5PrepareJoin,
  e2ee5NoteInvite,
  e2ee5AwaitKey,
  e2ee5OnKey,
  e2ee5Status,
  e2ee5RoomChanged,
  e2ee5NoteUnencrypted,
  e2ee5SendSdp,
  e2ee5TakeSdp,
  e2ee5HandleEvent,
  e2ee5SetPeer,
  e2ee5PeerUid,
  e2ee5NoteConv,
  e2ee5End,
  e2ee5Metrics,
  e2ee5NativeCaps,
  e2ee5BuildRoomE2ee,
  e2ee5Text,
};
