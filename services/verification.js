// [verificado 2026-10-24] Selo de verificado nível Instagram — contrato /root/verificado-2026-10-24/API.md.
//
// - verif_status / verif_submit (multipart) / verif_cancel / verif_check: tela app/verification.js.
// - verif_badges: lista de hex16 = sha256(lowercase(trim(email))).slice(0,16) das contas verificadas.
//   Cache em memória + AsyncStorage; revalida a cada ~10 min e ao voltar p/ 1º plano. O servidor só
//   devolve enabled=true p/ a allowlist (flag) — enabled=false → nenhum selo aparece em lugar nenhum.
// - useIsVerified(email) é barato: 1 Set.has sobre um hash memoizado; re-render só quando a lista muda.
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const STORE_KEY = 'verif_badges_v1';
const TTL_MS = 10 * 60 * 1000;

// ───────────── sha256 (JS puro, UTF-8) ─────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
export function sha256Hex(str) {
  const bytes = utf8Bytes(String(str));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += (H[i] >>> 0).toString(16).padStart(8, '0');
  return hex;
}

// ───────────── estado dos selos ─────────────
let _enabled = false;
let _ver = '';
let _set = new Set();
let _fetchedAt = 0;
let _rev = 0;            // muda a cada troca da lista → snapshot do useSyncExternalStore
let _loading = null;
let _hydrated = false;
let _appStateSub = null;
const _subs = new Set();
const _hashCache = new Map(); // email normalizado → hex16 (memo; limitado)

function _emit() { _rev++; _subs.forEach((fn) => { try { fn(); } catch {} }); }
function _subscribe(fn) { _subs.add(fn); ensureVerifiedBadges(); return () => _subs.delete(fn); }
function _snap() { return _rev; }

export function emailHash16(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.indexOf('@') < 1) return '';
  let h = _hashCache.get(e);
  if (h === undefined) {
    h = sha256Hex(e).slice(0, 16);
    if (_hashCache.size > 4000) _hashCache.clear();
    _hashCache.set(e, h);
  }
  return h;
}

/** Leitura síncrona (sem assinatura). Use dentro de useMemo junto com useVerifiedRev(). */
export function isVerifiedSync(email) {
  if (!_enabled || _set.size === 0 || !email) return false;
  const h = emailHash16(email);
  return !!h && _set.has(h);
}
export function verifiedBadgesEnabled() { return _enabled; }

/** Número que muda quando a lista de selos muda (p/ deps de useMemo em listas). */
export function useVerifiedRev() { _kick(); return useSyncExternalStore(_subscribe, _snap, _snap); }

/** true se a conta do e-mail tem selo (e a flag está ligada p/ quem vê). */
let _kicked = false;
function _kick() {
  // 1ª leitura do selo nesta sessão do app: hidrata do disco e revalida na rede (1x por abertura;
  // depois o TTL + volta p/ 1º plano). Força p/ não herdar a lista de outra conta no mesmo aparelho.
  if (_kicked) return;
  _kicked = true;
  setTimeout(() => { ensureVerifiedBadges(true); }, 0);
}
export function useIsVerified(email) {
  _kick();
  useSyncExternalStore(_subscribe, _snap, _snap);
  return isVerifiedSync(email);
}

function _apply(d, fromNet) {
  if (!d || typeof d !== 'object') return false;
  const en = !!d.enabled;
  let changed = en !== _enabled;
  _enabled = en;
  if (!en) {
    if (_set.size) changed = true;
    _set = new Set(); _ver = String(d.v || '');
  } else if (!(fromNet && d.same)) {
    const arr = Array.isArray(d.h) ? d.h.filter((x) => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x)) : [];
    const ns = new Set(arr);
    if (ns.size !== _set.size || arr.some((x) => !_set.has(x))) changed = true;
    _set = ns; _ver = String(d.v || '');
  }
  return changed;
}

async function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && typeof j === 'object') {
      if (_apply({ enabled: j.enabled, v: j.v, h: j.h }, false)) _emit();
      _fetchedAt = Number(j.at) || 0;
    }
  } catch {}
}

async function _persist() {
  try { await AsyncStorage.setItem(STORE_KEY, JSON.stringify({ enabled: _enabled, v: _ver, h: Array.from(_set), at: _fetchedAt })); } catch {}
}

/** Garante a lista carregada; revalida se passou do TTL (ou force). Nunca lança. */
export function ensureVerifiedBadges(force = false) {
  if (!_appStateSub && Platform.OS !== 'web') {
    try {
      _appStateSub = AppState.addEventListener('change', (st) => { if (st === 'active') ensureVerifiedBadges(); });
    } catch {}
  }
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      await _hydrate();
      if (!force && _fetchedAt && Date.now() - _fetchedAt < TTL_MS) return;
      const r = await api.apiCall('verif_badges', _ver ? { v: _ver } : {});
      if (r && r.success && r.data) {
        const changed = _apply(r.data, true);
        _fetchedAt = Date.now();
        _persist();
        if (changed) _emit();
      }
    } catch {} finally { _loading = null; }
  })();
  return _loading;
}

/** Troca de conta / logout: esquece a lista (outra pessoa pode não estar na allowlist). */
export function resetVerifiedBadges() {
  _enabled = false; _set = new Set(); _ver = ''; _fetchedAt = 0;
  try { AsyncStorage.removeItem(STORE_KEY); } catch {}
  _emit();
}

// ───────────── API da tela ─────────────
export async function verifStatus() {
  const r = await api.apiCall('verif_status', { _t: Date.now() });
  if (r && r.success && r.data) {
    // a própria conta: reflete o selo sem esperar o TTL
    if (r.data.enabled !== _enabled) ensureVerifiedBadges(true);
    return r.data;
  }
  const err = new Error((r && r.message) || 'verif_status');
  err.data = r && r.data; throw err;
}

export async function verifCheck(email) {
  try {
    const r = await api.apiCall('verif_check', { email });
    return !!(r && r.success && r.data && r.data.verified);
  } catch { return false; }
}

export async function verifCancel(id) {
  const r = await api.apiCall('verif_cancel', { id }, 'POST');
  if (r && r.success) return r.data || {};
  const err = new Error((r && r.message) || 'verif_cancel');
  err.data = r && r.data; throw err;
}

async function _appendFile(fd, field, uri) {
  if (!uri) return;
  if (Platform.OS === 'web') {
    const blob = await fetch(uri).then((x) => x.blob());
    fd.append(field, blob, field + '.jpg');
  } else {
    fd.append(field, { uri, type: 'image/jpeg', name: field + '.jpg' });
  }
}

/**
 * Envia o pedido. fields = {kind, category, full_name, known_as, country, doc_type, reason, links[], audience,
 * cnpj, business_ref, lang}; files = {doc_front, doc_back, selfie} (URIs JPEG locais).
 * Retorna data ({request}). Erro: Error com .data (data.code do contrato) e .message do servidor.
 */
export async function verifSubmit(fields, files) {
  const fd = new FormData();
  fd.append('action', 'verif_submit');
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k];
    if (v === undefined || v === null || v === '') return;
    fd.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  });
  fd.append('consent', '1');
  await _appendFile(fd, 'doc_front', files && files.doc_front);
  await _appendFile(fd, 'doc_back', files && files.doc_back);
  await _appendFile(fd, 'selfie', files && files.selfie);
  const { getAuthHeaders, BASE_URL } = require('./api');
  let res, j;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tm = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, 120000) : null;
  try {
    res = await fetch(`${BASE_URL}/api/email.php?action=verif_submit`, {
      method: 'POST', headers: getAuthHeaders(), body: fd, credentials: 'include', signal: ctl ? ctl.signal : undefined,
    });
    j = await res.json();
  } catch (e) {
    const err = new Error('network'); err.network = true; throw err;
  } finally { if (tm) clearTimeout(tm); }
  if (j && j.success) return j.data || {};
  const err = new Error((j && j.message) || ('HTTP ' + (res && res.status)));
  err.data = j && j.data; throw err;
}

// ───────────── entrada em Configurações (cache 5 min; nunca lança) ─────────────
let _entry = null, _entryAt = 0, _entryP = null;
export function peekVerifEntry() { return _entry; }
export function loadVerifEntry(force = false) {
  if (!force && _entry && Date.now() - _entryAt < 5 * 60 * 1000) return Promise.resolve(_entry);
  if (_entryP) return _entryP;
  _entryP = (async () => {
    try {
      const d = await verifStatus();
      const rq = d && d.request;
      _entry = { enabled: !!(d && d.enabled), verified: !!(d && d.verified), status: rq && rq.status !== 'cancelled' ? rq.status : '' };
      _entryAt = Date.now();
    } catch {} finally { _entryP = null; }
    return _entry;
  })();
  return _entryP;
}
