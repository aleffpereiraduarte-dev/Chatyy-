/**
 * E2EE v4 — cola entre o app e o núcleo (services/e2eeV4Core.js). [2026-10-09]
 *
 * - Só liga onde a flag de SERVIDOR deixa (e2ee_v4_status.allowed) e onde o
 *   aparelho tem armazenamento + WebCrypto + WebAssembly. Hoje: WEB. Nativo
 *   (iOS/Android) fica para a fase com build (Hermes sem crypto.subtle; o
 *   vodozemac entra como módulo nativo Rust/UniFFI).
 * - Tudo pesado (wasm do vodozemac ~440 KB) é carregado com import() sob
 *   demanda: quem nunca abre uma conversa cifrada não baixa nada.
 * - Armazenamento web: IndexedDB por conta; CADA valor é cifrado com AES-GCM
 *   por uma chave WebCrypto NÃO-EXPORTÁVEL guardada no próprio IndexedDB.
 *   (Protege contra cópia/leitura do storage por script; NÃO protege contra
 *   XSS ativo nem contra quem tem o perfil do navegador + acesso à máquina.)
 */
import { Platform } from 'react-native';
import * as api from './api';

const DB_NAME = 'chatyy-e2ee-v4';
const STORE = 'kv';
const norm = (s) => String(s || '').trim().toLowerCase();

let _mods = null;          // { Core, V }
let _engine = null;        // E2EEv4 do e-mail atual
let _engineEmail = null;
let _enginePromise = null;
const _convState = new Map(); // convId → status.conversation (+me/allowed)
let _lastStatus = null;

export function isSupported() {
  if (Platform.OS !== 'web') return false;
  try {
    return typeof globalThis.indexedDB !== 'undefined'
      && !!globalThis.crypto?.subtle
      && typeof globalThis.WebAssembly === 'object';
  } catch { return false; }
}

// ---------------- IndexedDB (valores cifrados) ----------------
function _idb() {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch {} };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function _tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const st = tx.objectStore(STORE);
    let out;
    try { out = fn(st); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function _makeStore(email) {
  const db = await _idb();
  const ns = `${email}::`;
  let wrap = await _tx(db, 'readonly', (st) => st.get(ns + '__wrapkey'));
  if (!wrap) {
    wrap = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await _tx(db, 'readwrite', (st) => st.put(wrap, ns + '__wrapkey'));
  }
  const te = new TextEncoder(), td = new TextDecoder();
  const enc = async (str) => {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(ns) }, wrap, te.encode(str)));
    const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
    return out;
  };
  const dec = async (bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 13) return null;
    try {
      const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(ns) }, wrap, bytes.slice(12));
      return td.decode(pt);
    } catch { return null; }
  };
  const get = async (k) => dec(await _tx(db, 'readonly', (st) => st.get(ns + k)));
  const setMany = async (obj) => {
    const entries = [];
    for (const [k, v] of Object.entries(obj)) entries.push([ns + k, v == null ? null : await enc(String(v))]);
    await _tx(db, 'readwrite', (st) => { for (const [k, v] of entries) { if (v == null) st.delete(k); else st.put(v, k); } });
  };
  const set = (k, v) => setMany({ [k]: v });
  const withLock = (fn) => {
    try {
      if (globalThis.navigator?.locks?.request) return globalThis.navigator.locks.request(`chatyy-e2ee-v4:${email}`, fn);
    } catch {}
    return fn();
  };
  return { get, set, setMany, getSecret: get, setSecret: set, withLock };
}

async function _loadMods() {
  if (_mods) return _mods;
  // .web.js carrega o wasm; o nativo lança e2ee_unsupported (sem wasm no bundle).
  _mods = await require('./e2eeV4Loader').loadE2EEv4();
  return _mods;
}

async function _apiCall(action, body) {
  try { return await api.apiCall(action, body || {}, 'POST'); } catch (e) { return { success: false, message: e?.message }; }
}

/** Status do servidor (flag + conversa). Nunca lança. */
export async function getStatus(convId) {
  const r = await _apiCall('e2ee_v4_status', convId ? { conversation_id: convId } : {});
  if (!r?.success || !r.data) return { allowed: false };
  const d = r.data;
  _lastStatus = d;
  if (convId && d.conversation) _convState.set(String(convId), { ...d.conversation, me: d.me, allowed: !!d.allowed });
  if (convId && !d.allowed) _convState.delete(String(convId));
  return d;
}

/** true se a conversa está com E2EE v4 ligado (cache do último status). */
export function isConversationE2ee(convId) {
  const s = _convState.get(String(convId));
  return !!(s && s.enabled);
}
export function getCachedConversationState(convId) { return _convState.get(String(convId)) || null; }

let _statusPromise = null;
async function _getEngine(meEmail) {
  if (!isSupported()) return null;
  let me = norm(meEmail || _lastStatus?.me);
  if (!me) {
    // Mensagens do cache chegam antes do status da conversa: descobre a conta
    // (e a flag) aqui, uma vez só, em vez de falhar o decrypt.
    if (!_statusPromise) _statusPromise = getStatus().finally(() => { _statusPromise = null; });
    const st = await _statusPromise;
    if (!st?.allowed) return null;
    me = norm(st.me);
  }
  if (!me) return null;
  if (_engine && _engineEmail === me) return _engine;
  if (_enginePromise && _engineEmail === me) return _enginePromise;
  _engineEmail = me;
  _enginePromise = (async () => {
    const { Core, V } = await _loadMods();
    const store = await _makeStore(me);
    const eng = new Core.E2EEv4({ api: _apiCall, store, V, platform: 'web', label: 'Web' });
    await eng.init(me);
    _engine = eng;
    return eng;
  })();
  try { return await _enginePromise; } finally { _enginePromise = null; }
}

/**
 * Chamado ao abrir uma conversa. Se a conta tem a flag, publica as chaves
 * deste aparelho (para o outro lado poder ligar a criptografia) e devolve o
 * estado. { supported, allowed, enabled, peer, peerAllowed, peerDevices, me }
 */
export async function prepareConversation(convId) {
  const st = await getStatus(convId);
  const conv = st.conversation || {};
  const out = {
    supported: isSupported(), allowed: !!st.allowed, me: st.me || null,
    enabled: !!conv.enabled, type: conv.type || null, peer: conv.peer || null,
    peerAllowed: !!conv.peer_allowed, peerDevices: conv.peer_devices || 0,
  };
  if (out.allowed && out.supported) {
    try {
      const eng = await _getEngine(out.me);
      await eng?.ensureRegistered();
      out.ready = !!eng;
    } catch (e) { out.ready = false; out.error = e?.code || e?.message; }
  }
  return out;
}

export async function enableConversation(convId) {
  const r = await _apiCall('e2ee_v4_enable', { conversation_id: convId });
  await getStatus(convId);
  return { success: !!r?.success, code: r?.data?.code || null, message: r?.message || null };
}

export async function disableConversation(convId) {
  const r = await _apiCall('e2ee_v4_disable', { conversation_id: convId });
  await getStatus(convId);
  return { success: !!r?.success };
}

/** Cifra; lança Error com .code (peer_no_keys, e2ee_unsupported, …). */
export async function encryptText(convId, peerEmail, text) {
  const eng = await _getEngine();
  if (!eng) { const e = new Error('e2ee_unsupported'); e.code = 'e2ee_unsupported'; throw e; }
  return eng.encryptText(convId, peerEmail, text);
}

export function isV4Blob(raw) {
  return typeof raw === 'string' && raw.startsWith('{"e2e":4');
}

// Falhas recentes por envelope: evita re-tentar (e re-buscar o diretório) a
// cada re-render da lista. Expira em 60 s para cobrir chave que chega depois.
const _failMemo = new Map();
function _mid(raw) { const m = /"mid":"([A-Za-z0-9_-]+)"/.exec(raw || ''); return m ? m[1] : null; }

/** Falha recente (síncrono) → código, senão null. */
export function peekFailure(raw) {
  const mid = _mid(raw);
  const f = mid ? _failMemo.get(mid) : null;
  if (!f) return null;
  if (Date.now() - f.at > 60000) { _failMemo.delete(mid); return null; }
  return f.code;
}

/** { ok, text } | { ok:false, code } — nunca lança. */
export async function decryptForDisplay(raw, ctx) {
  if (!isV4Blob(raw)) return { ok: false, code: 'bad_envelope' };
  let r;
  if (!isSupported()) r = { ok: false, code: 'e2ee_unsupported' };
  else {
    try {
      const eng = await _getEngine();
      if (!eng) r = { ok: false, code: 'e2ee_unsupported' };
      else {
        const c = { ...(ctx || {}) };
        if (!c.senderEmail && c.convId != null) {
          const st = _convState.get(String(c.convId));
          if (st) c.candidates = [st.me, st.peer].filter(Boolean);
        }
        r = await eng.decryptBlob(raw, c);
      }
    } catch (e) {
      r = { ok: false, code: e?.code || 'decrypt_failed' };
    }
  }
  const mid = _mid(raw);
  if (mid) { if (r.ok) _failMemo.delete(mid); else _failMemo.set(mid, { code: r.code, at: Date.now() }); }
  return r;
}

/** Texto já decifrado neste aparelho (síncrono; para prévia da lista). */
export function peekPlaintext(raw) {
  try { return _engine && isV4Blob(raw) ? _engine.peekPlaintext(raw) : null; } catch { return null; }
}

/** Texto do balão quando não dá para abrir (sem emoji — ícone SVG fica na UI). */
export function placeholderText(code, t) {
  const tr = (k, fb) => { const v = t ? t(k) : null; return v && v !== k ? v : fb; };
  if (code === 'not_for_device' || code === 'e2ee_unsupported') return tr('e2ee.notOnThisDevice', 'Mensagem criptografada. Abra no aparelho em que a criptografia está ativa.');
  return tr('e2ee.cannotDecrypt', 'Não foi possível descriptografar esta mensagem.');
}

export async function safetyNumber(peerEmail) {
  const eng = await _getEngine();
  if (!eng) return null;
  return eng.safetyNumber(peerEmail);
}

export async function setVerified(peerEmail, verified) {
  const eng = await _getEngine();
  if (eng) await eng.setVerified(peerEmail, verified);
}

export default {
  isSupported, getStatus, isConversationE2ee, getCachedConversationState, prepareConversation,
  enableConversation, disableConversation, encryptText, isV4Blob, decryptForDisplay,
  peekPlaintext, peekFailure, placeholderText, safetyNumber, setVerified,
};
