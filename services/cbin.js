// [cbin 2026-10-24] "cbin v1" — fio binário compacto do Chatyy (estilo FunXMPP do WhatsApp), lado JS.
// Transcodificação SEM PERDA de JSON: encode(valor) → Uint8Array; decode(bytes) → valor (igual ao JSON.parse do JSON
// que o servidor teria mandado). Tokens de 1 byte do dicionário fixo (cbinDict.js, versionado + hash), inteiros e ids
// em varint, base64/hex/uuid em bytes crus, datas em varint, JSON dentro de string (envelope E2EE) aninhado.
// Contrato e tags: /root/cbin-2026-10-24/CBIN.md (mesmo do Go chatyy-ws/cbin, Swift ChatyyCbin, Kotlin ChatyyCbin).
// Desligado por padrão: só é usado depois de cbin_hello → cbin_ok (websocket.js; flag __chatyy_cbin === true).
// Qualquer valor que não dê para representar sem perda (surrogate solto) → encode lança → o chamador manda JSON.
import DICT from './cbinDict';

const T = {
  NULL: 0x00, FALSE: 0x01, TRUE: 0x02, UINT: 0x03, NEG: 0x04, NUMLIT: 0x05, STR: 0x06, VAL: 0x07, DEC: 0x08,
  B64: 0x09, B64URL: 0x0a, HEX: 0x0b, UUID: 0x0c, ARR: 0x0d, OBJ: 0x0e, EMAIL: 0x0f, JSONSTR: 0x10, TIME: 0x11,
  PFX: 0x12, B64RAW: 0x13, SHORT: 0x20, SMALL: 0x40, VALINL: 0x80,
};
const MAX_FRAME = 1 << 20;

function idx(list) { const m = new Map(); list.forEach((s, i) => { if (!m.has(s)) m.set(s, i); }); return m; }
const D = {
  version: DICT.version, hash: DICT.hash, types: DICT.types, keys: DICT.keys, vals: DICT.vals, doms: DICT.doms, pfx: DICT.pfx,
  typeIdx: idx(DICT.types), keyIdx: idx(DICT.keys), valIdx: idx(DICT.vals), domIdx: idx(DICT.doms),
};
export const CBIN_VERSION = D.version;
export const CBIN_DICT_HASH = D.hash;

// ── UTF-8 (Hermes nem sempre tem TextEncoder) ──
function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) { out.push(c); continue; }
    if (c >= 0xd800 && c < 0xdc00) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo < 0xdc00 || lo >= 0xe000) throw new Error('cbin: surrogate solto');
      c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++;
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      continue;
    }
    if (c >= 0xdc00 && c < 0xe000) throw new Error('cbin: surrogate solto');
    if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function isAscii(s) { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false; return true; }
function fromUtf8(b, a, e) {
  let s = '';
  let i = a;
  while (i < e) {
    const c = b[i];
    if (c < 0x80) { s += String.fromCharCode(c); i++; continue; }
    let cp, n;
    if (c >= 0xc2 && c < 0xe0) { cp = c & 0x1f; n = 1; } else if (c >= 0xe0 && c < 0xf0) { cp = c & 0x0f; n = 2; } else if (c >= 0xf0 && c < 0xf5) { cp = c & 0x07; n = 3; } else throw new Error('cbin: utf8');
    if (i + n >= e) throw new Error('cbin: utf8');
    for (let k = 1; k <= n; k++) { const cc = b[i + k]; if ((cc & 0xc0) !== 0x80) throw new Error('cbin: utf8'); cp = (cp << 6) | (cc & 0x3f); }
    if ((n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff))) throw new Error('cbin: utf8');
    i += n + 1;
    if (cp >= 0x10000) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); } else s += String.fromCharCode(cp);
  }
  return s;
}

// ── buffer de saída ──
class Out {
  constructor() { this.b = new Uint8Array(256); this.n = 0; }
  need(k) { if (this.n + k > this.b.length) { let L = this.b.length * 2; while (L < this.n + k) L *= 2; const nb = new Uint8Array(L); nb.set(this.b.subarray(0, this.n)); this.b = nb; } }
  byte(x) { this.need(1); this.b[this.n++] = x; }
  bytes(a) { this.need(a.length); for (let i = 0; i < a.length; i++) this.b[this.n++] = a[i]; }
  uvar(u) { // u: Number inteiro ≥ 0 (seguro) ou BigInt
    if (typeof u === 'bigint') { while (u >= 0x80n) { this.byte(Number(u & 0x7fn) | 0x80); u >>= 7n; } this.byte(Number(u)); return; }
    while (u >= 0x80) { this.byte((u % 128) | 0x80); u = Math.floor(u / 128); }
    this.byte(u);
  }
  str(bytes) { this.uvar(bytes.length); this.bytes(bytes); }
  done() { return this.b.slice(0, this.n); }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64REV = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) { m[B64.charCodeAt(i)] = i; } m[45] = 62; m[95] = 63; return m; })();
function b64enc(bytes, alpha, pad) {
  let s = ''; let i = 0;
  for (; i + 2 < bytes.length; i += 3) { const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]; s += alpha[v >> 18] + alpha[(v >> 12) & 63] + alpha[(v >> 6) & 63] + alpha[v & 63]; }
  const r = bytes.length - i;
  if (r === 1) { const v = bytes[i] << 16; s += alpha[v >> 18] + alpha[(v >> 12) & 63] + (pad ? '==' : ''); } else if (r === 2) { const v = (bytes[i] << 16) | (bytes[i + 1] << 8); s += alpha[v >> 18] + alpha[(v >> 12) & 63] + alpha[(v >> 6) & 63] + (pad ? '=' : ''); }
  return s;
}
// decodifica sem padding; null se char inválido p/ o alfabeto
function b64dec(s, url) {
  const n = s.length; const out = [];
  let acc = 0; let bits = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) return null;
    if (url ? (c === 43 || c === 47) : (c === 45 || c === 95)) return null;
    const v = B64REV[c]; if (v < 0) return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  return out;
}
const HEXD = '0123456789abcdef';
function isLowerHex(s) { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false; } return true; }
function hexToBytes(s) { const o = new Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }
function bytesToHex(b, a, e) { let s = ''; for (let i = a; i < e; i++) s += HEXD[b[i] >> 4] + HEXD[b[i] & 15]; return s; }
function isUUID(s) {
  if (s.length !== 36) return false;
  for (let i = 0; i < 36; i++) { const c = s.charCodeAt(i); if (i === 8 || i === 13 || i === 18 || i === 23) { if (c !== 45) return false; } else if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false; }
  return true;
}
const U64MAX = 18446744073709551615n;
function isDecCanon(s) { if (s.length < 2 || s.length > 20 || s.charCodeAt(0) === 48) return false; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 48 || c > 57) return false; } return s.length < 20 || BigInt(s) <= U64MAX; }

// ── datas (mesmo formato do Go encTime/decTime) ──
function daysFromCivil(y, m, d) { if (m <= 2) y--; const era = Math.floor(y / 400); const yoe = y - era * 400; const mp = (m + 9) % 12; const doy = Math.floor((153 * mp + 2) / 5) + d - 1; const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; return era * 146097 + doe - 719468; }
function civilFromDays(z) { z += 719468; const era = Math.floor(z / 146097); const doe = z - era * 146097; const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365); let y = yoe + era * 400; const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); const mp = Math.floor((5 * doy + 2) / 153); const d = doy - Math.floor((153 * mp + 2) / 5) + 1; let m = mp + 3; if (m > 12) m -= 12; if (m <= 2) y++; return [y, m, d]; }
const p2 = (v) => (v < 10 ? '0' : '') + v;
function zz(v) { return v >= 0 ? v * 2 : -v * 2 - 1; }
function unzz(u) { return (u % 2) ? -(u + 1) / 2 : u / 2; }
const TIME_RE = /^(\d{4})-(\d\d)-(\d\d)([T ])(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d(?::\d\d)?)?$/;
function timeParts(s) {
  const m = TIME_RE.exec(s); if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[5], mi = +m[6], ss = +m[7];
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const days = daysFromCivil(y, mo, d); const c = civilFromDays(days); if (c[0] !== y || c[1] !== mo || c[2] !== d) return null;
  const fd = m[8] ? m[8].length : 0; const frac = m[8] ? Number(m[8]) : 0;
  let zk = 0, zmin = 0;
  if (m[9] === 'Z') zk = 1; else if (m[9]) { const sign = m[9][0] === '-' ? -1 : 1; const zh = +m[9].slice(1, 3); if (m[9].length === 3) { zk = 2; zmin = sign * zh * 60; } else { const zm = +m[9].slice(4, 6); if (zm > 59) return null; zk = 3; zmin = sign * (zh * 60 + zm); } }
  const desc = (fd << 1) | (zk << 5) | (m[4] === 'T' ? 1 : 0);
  return { secs: days * 86400 + hh * 3600 + mi * 60 + ss, desc, fd, frac, zk, zmin };
}
function fmtTime(secs, desc, frac, zmin) {
  const fd = (desc >> 1) & 15, zk = (desc >> 5) & 3;
  const days = Math.floor(secs / 86400), rem = secs - days * 86400; const [y, mo, d] = civilFromDays(days);
  let s = String(y).padStart(4, '0') + '-' + p2(mo) + '-' + p2(d) + ((desc & 1) ? 'T' : ' ') + p2(Math.floor(rem / 3600)) + ':' + p2(Math.floor(rem / 60) % 60) + ':' + p2(rem % 60);
  if (fd > 0) { const f = String(frac); if (f.length > fd) throw new Error('cbin: frac'); s += '.' + f.padStart(fd, '0'); }
  if (zk === 1) s += 'Z'; else if (zk >= 2) { let z = zmin; s += z < 0 ? '-' : '+'; z = Math.abs(z); s += p2(Math.floor(z / 60)); if (zk === 3) s += ':' + p2(z % 60); }
  return s;
}

// ── codificador ──
function encStr(o, s, depth) {
  const vi = D.valIdx.get(s);
  if (vi !== undefined) { if (vi < 128) o.byte(T.VALINL + vi); else { o.byte(T.VAL); o.uvar(vi); } return; }
  const n = s.length; // em UTF-16; os testes de forma abaixo são ASCII
  if (n >= 2 && n <= 20 && isDecCanon(s)) { o.byte(T.DEC); o.uvar(n > 15 ? BigInt(s) : Number(s)); return; }
  if (n >= 19 && n <= 35 && s.charCodeAt(4) === 45) {
    const t = timeParts(s);
    if (t && fmtTime(t.secs, t.desc, t.frac, t.zmin) === s) { o.byte(T.TIME); o.uvar(t.secs); o.byte(t.desc); if (t.fd > 0) o.uvar(t.frac); if (t.zk >= 2) o.uvar(zz(t.zmin)); return; }
  }
  if (n >= 3) {
    const at = s.lastIndexOf('@');
    if (at > 0) { const di = D.domIdx.get(s.slice(at + 1)); if (di !== undefined) { o.byte(T.EMAIL); o.str(utf8(s.slice(0, at))); o.uvar(di); return; } }
  }
  if (n >= 8 && (s[0] === 'h' || s[0] === '/')) {
    let best = -1, bl = 0;
    for (let i = 0; i < D.pfx.length; i++) { const p = D.pfx[i]; if (p.length > bl && p.length <= n && s.startsWith(p)) { best = i; bl = p.length; } }
    if (best >= 0) { o.byte(T.PFX); o.uvar(best); o.str(utf8(s.slice(bl))); return; }
  }
  if (n === 36 && isUUID(s)) { o.byte(T.UUID); o.bytes(hexToBytes(s.replace(/-/g, ''))); return; }
  if (n >= 8 && n % 2 === 0 && isLowerHex(s)) { o.byte(T.HEX); o.uvar(n / 2); o.bytes(hexToBytes(s)); return; }
  if (n >= 8 && (s[0] === '{' || s[0] === '[') && depth < 8) {
    let v; let ok = false;
    try { v = JSON.parse(s); ok = v !== null && typeof v === 'object' && JSON.stringify(v) === s; } catch { ok = false; }
    if (ok) {
      const mark = o.n;
      try { o.byte(T.JSONSTR); encValue(o, v, depth + 1); return; } catch (e) { o.n = mark; }
    }
  }
  if (n >= 12 && isAscii(s)) {
    if (n % 4 === 0) { const raw = b64dec(s.replace(/={1,2}$/, ''), false); if (raw && b64enc(raw, B64, true) === s) { o.byte(T.B64); o.str(raw); return; } }
    if (n % 4 !== 0 && n % 4 !== 1 && n >= 16 && s[n - 1] !== '=') { const raw = b64dec(s, false); if (raw && b64enc(raw, B64, false) === s) { o.byte(T.B64RAW); o.str(raw); return; } }
    if (n % 4 !== 1 && n >= 16) { const raw = b64dec(s, true); if (raw && b64enc(raw, B64U, false) === s) { o.byte(T.B64URL); o.str(raw); return; } }
  }
  const b = utf8(s);
  if (b.length < 32) { o.byte(T.SHORT + b.length); o.bytes(b); } else { o.byte(T.STR); o.str(b); }
}

function encNum(o, x) {
  if (!Number.isFinite(x)) { o.byte(T.NULL); return; } // JSON.stringify(NaN) = null
  if (Number.isSafeInteger(x)) {
    if (x >= 0) { if (x < 64) o.byte(T.SMALL + x); else { o.byte(T.UINT); o.uvar(x); } } else { o.byte(T.NEG); o.uvar(-x - 1); }
    return;
  }
  o.byte(T.NUMLIT); o.str(utf8(JSON.stringify(x)));
}

function encKey(o, k) {
  const i = D.keyIdx.get(k);
  if (i !== undefined) o.uvar(i + 1); else { o.byte(0); o.str(utf8(k)); }
}

function jsonable(v) { return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'; }

function encValue(o, v, depth) {
  if (depth > 64) throw new Error('cbin: profundidade');
  if (v !== null && typeof v === 'object' && typeof v.toJSON === 'function') v = v.toJSON();
  if (v === null) { o.byte(T.NULL); return; }
  switch (typeof v) {
    case 'boolean': o.byte(v ? T.TRUE : T.FALSE); return;
    case 'number': encNum(o, v); return;
    case 'string': encStr(o, v, depth); return;
    case 'bigint': throw new Error('cbin: bigint');
    case 'object': break;
    default: o.byte(T.NULL); return;
  }
  if (Array.isArray(v)) {
    o.byte(T.ARR); o.uvar(v.length);
    for (let i = 0; i < v.length; i++) { const x = v[i]; if (jsonable(x)) encValue(o, x, depth + 1); else o.byte(T.NULL); }
    return;
  }
  const ks = Object.keys(v).filter((k) => jsonable(v[k]));
  o.byte(T.OBJ); o.uvar(ks.length);
  for (const k of ks) { encKey(o, k); encValue(o, v[k], depth + 1); }
}

/** Codifica 1 frame (objeto do _send). Lança se não der sem perda → mande JSON. */
export function encode(v) {
  const o = new Out();
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.toJSON !== 'function' && typeof v.type === 'string' && D.typeIdx.has(v.type)) {
    o.uvar(D.typeIdx.get(v.type) + 1);
    for (const k of Object.keys(v)) {
      if (k === 'type' || !jsonable(v[k])) continue;
      encKey(o, k); encValue(o, v[k], 1);
    }
  } else {
    o.byte(0); encValue(o, v, 0);
  }
  if (o.n > MAX_FRAME) throw new Error('cbin: grande demais');
  return o.done();
}

// ── decodificador ──
class In {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { if (this.p >= this.b.length) throw new Error('cbin: truncado'); return this.b[this.p++]; }
  uvar() { // Number se couber em 2^53, senão BigInt
    let lo = 0, mul = 1, i = 0, big = null;
    for (;;) {
      if (this.p >= this.b.length || i >= 10) throw new Error('cbin: varint');
      const c = this.b[this.p++];
      if (big !== null) big |= BigInt(c & 0x7f) << BigInt(7 * i);
      else if (i >= 7) { big = BigInt(lo) | (BigInt(c & 0x7f) << BigInt(7 * i)); } else lo += (c & 0x7f) * mul;
      mul *= 128; i++;
      if (!(c & 0x80)) break;
    }
    if (big !== null) { if (big > U64MAX) throw new Error('cbin: varint'); return big <= 9007199254740991n ? Number(big) : big; }
    return lo;
  }
  len() { const n = this.uvar(); if (typeof n !== 'number' || n > this.b.length - this.p) throw new Error('cbin: truncado'); return n; }
  str() { const n = this.len(); const s = fromUtf8(this.b, this.p, this.p + n); this.p += n; return s; }
  raw() { const n = this.len(); const a = this.b.subarray(this.p, this.p + n); this.p += n; return a; }
}

function setProp(o, k, v) { if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); else o[k] = v; }

function decKey(r) {
  const k = r.uvar();
  if (k === 0) return r.str();
  if (typeof k !== 'number' || k > D.keys.length) throw new Error('cbin: chave');
  return D.keys[k - 1];
}

// asText: true → devolve TEXTO JSON canônico (p/ o valor de um tJSONStr); false → valor JS
function decValue(r, depth, asText) {
  if (depth > 72) throw new Error('cbin: profundidade');
  const t = r.u8();
  const S = (s) => (asText ? JSON.stringify(s) : s);
  if (t >= T.VALINL) { const i = t - T.VALINL; if (i >= D.vals.length) throw new Error('cbin: val'); return S(D.vals[i]); }
  if (t >= T.SMALL) { const v = t - T.SMALL; return asText ? String(v) : v; }
  if (t >= T.SHORT) { const n = t - T.SHORT; if (n > r.b.length - r.p) throw new Error('cbin: truncado'); const s = fromUtf8(r.b, r.p, r.p + n); r.p += n; return S(s); }
  switch (t) {
    case T.NULL: return asText ? 'null' : null;
    case T.FALSE: return asText ? 'false' : false;
    case T.TRUE: return asText ? 'true' : true;
    case T.UINT: { const u = r.uvar(); if (u < 64) throw new Error('cbin: não canônico'); return asText ? String(u) : Number(u); }
    case T.NEG: { const u = r.uvar(); const v = typeof u === 'bigint' ? -(u + 1n) : -(u + 1); return asText ? String(v) : Number(v); }
    case T.NUMLIT: { const s = r.str(); if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) throw new Error('cbin: número'); return asText ? s : Number(s); }
    case T.STR: return S(r.str());
    case T.VAL: { const i = r.uvar(); if (typeof i !== 'number' || i >= D.vals.length) throw new Error('cbin: val'); return S(D.vals[i]); }
    case T.DEC: return S(String(r.uvar()));
    case T.B64: return S(b64enc(r.raw(), B64, true));
    case T.B64URL: return S(b64enc(r.raw(), B64U, false));
    case T.B64RAW: return S(b64enc(r.raw(), B64, false));
    case T.HEX: { const a = r.raw(); return S(bytesToHex(a, 0, a.length)); }
    case T.UUID: { if (r.b.length - r.p < 16) throw new Error('cbin: truncado'); const h = bytesToHex(r.b, r.p, r.p + 16); r.p += 16; return S(h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)); }
    case T.ARR: {
      const n = r.uvar(); if (typeof n !== 'number' || n > r.b.length - r.p) throw new Error('cbin: truncado');
      if (asText) { const parts = new Array(n); for (let i = 0; i < n; i++) parts[i] = decValue(r, depth + 1, true); return '[' + parts.join(',') + ']'; }
      const a = new Array(n); for (let i = 0; i < n; i++) a[i] = decValue(r, depth + 1, false); return a;
    }
    case T.OBJ: {
      const n = r.uvar(); if (typeof n !== 'number' || n > (r.b.length - r.p) / 2) throw new Error('cbin: truncado');
      if (asText) { const parts = new Array(n); for (let i = 0; i < n; i++) { const k = decKey(r); parts[i] = JSON.stringify(k) + ':' + decValue(r, depth + 1, true); } return '{' + parts.join(',') + '}'; }
      const o = {}; for (let i = 0; i < n; i++) { const k = decKey(r); setProp(o, k, decValue(r, depth + 1, false)); } return o;
    }
    case T.EMAIL: { const loc = r.str(); const di = r.uvar(); if (typeof di !== 'number' || di >= D.doms.length) throw new Error('cbin: dom'); return S(loc + '@' + D.doms[di]); }
    case T.PFX: { const pi = r.uvar(); const rest = r.str(); if (typeof pi !== 'number' || pi >= D.pfx.length) throw new Error('cbin: pfx'); return S(D.pfx[pi] + rest); }
    case T.JSONSTR: { const txt = decValue(r, depth + 1, true); return S(txt); }
    case T.TIME: {
      const secs = r.uvar(); const desc = r.u8();
      if (typeof secs !== 'number' || secs > 253402300799 || (desc & 0x80) || ((desc >> 1) & 15) > 9) throw new Error('cbin: data');
      const fd = (desc >> 1) & 15, zk = (desc >> 5) & 3;
      const frac = fd > 0 ? r.uvar() : 0; let zmin = 0;
      if (zk >= 2) { zmin = unzz(r.uvar()); if (zmin <= -6000 || zmin >= 6000 || (zk === 2 && zmin % 60 !== 0)) throw new Error('cbin: zona'); }
      if (typeof frac !== 'number') throw new Error('cbin: frac');
      return S(fmtTime(secs, desc, frac, zmin));
    }
    default: throw new Error('cbin: tag ' + t);
  }
}

/** Decodifica 1 frame binário → valor (o mesmo que JSON.parse do JSON canônico). Lança se inválido. */
export function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length === 0 || b.length > MAX_FRAME) throw new Error('cbin: tamanho');
  const r = new In(b);
  const t = r.uvar();
  let v;
  if (t === 0) v = decValue(r, 0, false);
  else {
    if (typeof t !== 'number' || t > D.types.length) throw new Error('cbin: tipo');
    v = { type: D.types[t - 1] };
    while (r.p < b.length) { const k = decKey(r); setProp(v, k, decValue(r, 1, false)); }
  }
  if (r.p !== b.length) throw new Error('cbin: sobra');
  return v;
}

/** Frames que nunca vão em cbin (o servidor também manda sempre em texto). */
export function jsonOnly(v) {
  const t = v && typeof v === 'object' ? v.type : null;
  return typeof t === 'string' && (t === 'auth' || t.startsWith('auth_') || t.startsWith('cbin_'));
}

export function helloFrame() { return { type: 'cbin_hello', v: [D.version], dh: D.hash }; }
