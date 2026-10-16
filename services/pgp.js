/**
 * [2026-10-16 pgp-v2] Núcleo OpenPGP do Chatyy (tela Chave PGP, compose, leitor).
 *
 * - Chave nova = ECC Curve25519 (v4, compatível com GnuPG/Thunderbird/Proton).
 *   RSA-4096 em JS no Hermes levava minutos e estourava o limite do SecureStore.
 * - Chave privada SEMPRE cifrada pela senha do usuário (S2K do OpenPGP) e
 *   guardada POR CONTA: SecureStore no app, localStorage no web (continua
 *   cifrada; o aviso na tela pede backup). Nunca vai ao servidor.
 * - Pública vai ao PG (pgp_key_upload) p/ outros usuários do Chatyy cifrarem.
 * - Chaves de contatos importadas manualmente ficam no aparelho (AsyncStorage).
 * - Chave destrancada fica só em memória por 15 min (assinar no compose).
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pgpKeyUpload, pgpKeyDelete, pgpKeyGet } from './api';

// ── polyfills p/ Hermes ──
// openpgp v6 EXIGE globalThis.crypto.subtle (sem ele o import lança "The WebCrypto
// API is not available" → a tela Chave PGP nunca funcionou no app nativo).
// Toda operação do subtle no openpgp cai no fallback JS interno (noble/tweetnacl)
// quando recebe NotSupportedError — menos o digest. Então, SÓ no nativo:
// digest real (expo-crypto nativo → JS puro) + demais métodos = NotSupportedError.
// Nunca substitui método que já exista (e2eeV4Native instala digest SHA-512).
function notSupported() {
  const e = new Error('not supported (chatyy polyfill)'); e.name = 'NotSupportedError';
  return Promise.reject(e);
}
function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
const K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function mdPad(u8) {
  const len = u8.length, bitsHi = Math.floor(len / 0x20000000), bitsLo = (len * 8) >>> 0;
  const total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total); m.set(u8); m[len] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 8, bitsHi); dv.setUint32(total - 4, bitsLo);
  return dv;
}
function sha256js(u8) {
  const dv = mdPad(u8), W = new Uint32Array(64);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i-15], b = W[i-2];
      W[i] = (W[i-16] + (rotr(a,7) ^ rotr(a,18) ^ (a>>>3)) + W[i-7] + (rotr(b,17) ^ rotr(b,19) ^ (b>>>10))) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
  }
  const out = new DataView(new ArrayBuffer(32));
  [h0,h1,h2,h3,h4,h5,h6,h7].forEach((v, i) => out.setUint32(i * 4, v));
  return out.buffer;
}
function sha1js(u8) {
  const dv = mdPad(u8), W = new Uint32Array(80);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476,e0=0xc3d2e1f0;
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = W[i-3] ^ W[i-8] ^ W[i-14] ^ W[i-16]; W[i] = (x << 1) | (x >>> 31); }
    let a=a0,b=b0,c=c0,d=d0,e=e0;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1 : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc : (b ^ c ^ d) + 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + W[i]) >>> 0;
      e=d; d=c; c=(b << 30) | (b >>> 2); b=a; a=t;
    }
    a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;e0=(e0+e)>>>0;
  }
  const out = new DataView(new ArrayBuffer(20));
  [a0,b0,c0,d0,e0].forEach((v, i) => out.setUint32(i * 4, v >>> 0));
  return out.buffer;
}
async function polyDigest(algo, data) {
  const name = String(typeof algo === 'string' ? algo : algo?.name || '').toUpperCase().replace('SHA', 'SHA-').replace('--', '-');
  const u8 = toU8(data);
  try {
    const EC = require('expo-crypto');
    const map = { 'SHA-1': EC.CryptoDigestAlgorithm.SHA1, 'SHA-256': EC.CryptoDigestAlgorithm.SHA256, 'SHA-384': EC.CryptoDigestAlgorithm.SHA384, 'SHA-512': EC.CryptoDigestAlgorithm.SHA512 };
    if (map[name] && typeof EC.digest === 'function') return await EC.digest(map[name], u8);
  } catch {}
  if (name === 'SHA-256') return sha256js(u8);
  if (name === 'SHA-1') return sha1js(u8);
  if (name === 'SHA-512') { const nacl = require('tweetnacl'); const h = nacl.hash(u8); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength); }
  const e = new Error('digest ' + name); e.name = 'NotSupportedError'; throw e;
}
function ensureCryptoGlobals() {
  const g = typeof globalThis !== 'undefined' ? globalThis : global;
  if (!g.crypto) { try { g.crypto = {}; } catch {} }
  if (g.crypto && typeof g.crypto.getRandomValues !== 'function') {
    try {
      const ExpoCrypto = require('expo-crypto');
      g.crypto.getRandomValues = (arr) => { ExpoCrypto.getRandomValues(arr); return arr; };
    } catch {}
  }
  if (Platform.OS !== 'web' && g.crypto) {
    const subtle = g.crypto.subtle || {};
    if (!subtle.__chatyyPgp) {
      subtle.digest = polyDigest; // nativo: digest completo (SHA-1/256/384/512); SHA-512 igual ao anterior
      for (const k of ['importKey', 'exportKey', 'generateKey', 'encrypt', 'decrypt', 'sign', 'verify', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey']) {
        if (typeof subtle[k] !== 'function') subtle[k] = notSupported;
      }
      try { Object.defineProperty(subtle, '__chatyyPgp', { value: true }); } catch {}
      try { g.crypto.subtle = subtle; } catch {}
    }
  }
  if (typeof g.TextDecoder === 'undefined') {
    try { const te = require('text-encoding'); g.TextDecoder = te.TextDecoder; if (!g.TextEncoder) g.TextEncoder = te.TextEncoder; } catch {}
  }
}
export const __test = { sha256js, sha1js, polyDigest };

let _openpgp = null;
export async function loadOpenPGP() {
  if (_openpgp) return _openpgp;
  ensureCryptoGlobals();
  // Bundle de navegador: o "main" do pacote é o build Node (importa "module").
  const mod = await import('openpgp/dist/openpgp.min.mjs');
  _openpgp = mod?.default && mod.default.generateKey ? mod.default : mod;
  return _openpgp;
}

// ── armazenamento por conta ──
const norm = (e) => String(e || '').trim().toLowerCase();
const ssName = (kind, email) => `pgp_v2_${kind}_` + norm(email).replace(/[^a-z0-9._-]/g, '_');
const LEGACY = { priv: 'pgp_private_armor_v1', pub: 'pgp_public_armor_v1', fpr: 'pgp_fingerprint_v1' };

function lsGet(k) { try { return (typeof localStorage !== 'undefined' && localStorage.getItem(k)) || ''; } catch { return ''; } }
function lsSet(k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch {} }

async function secGet(k) {
  if (Platform.OS === 'web') return lsGet(k);
  try { return (await SecureStore.getItemAsync(k)) || ''; } catch { return ''; }
}
async function secSet(k, v) {
  if (Platform.OS === 'web') { lsSet(k, v); return lsGet(k) === v; }
  await SecureStore.setItemAsync(k, v); // erro sobe: não fingir que salvou
  return true;
}
async function secDel(k) {
  if (Platform.OS === 'web') { lsDel(k); return; }
  try { await SecureStore.deleteItemAsync(k); } catch {}
}

export const isWebStorage = Platform.OS === 'web';

/** Minha chave (ou null). Migra a v1 global se o userID bater com a conta. */
export async function getMyKey(email) {
  const e = norm(email);
  if (!e) return null;
  let priv = await secGet(ssName('priv', e));
  let pub = await secGet(ssName('pub', e));
  if (!priv || !pub) {
    const lp = await secGet(LEGACY.priv);
    const lu = await secGet(LEGACY.pub);
    if (lp && lu) {
      try {
        const pgp = await loadOpenPGP();
        const k = await pgp.readKey({ armoredKey: lu });
        const ids = (k.getUserIDs?.() || []).join(' ').toLowerCase();
        if (ids.includes(e)) {
          await secSet(ssName('priv', e), lp); await secSet(ssName('pub', e), lu);
          await secDel(LEGACY.priv); await secDel(LEGACY.pub); await secDel(LEGACY.fpr);
          priv = lp; pub = lu;
        }
      } catch {}
    }
  }
  if (!priv || !pub) return null;
  try {
    const pgp = await loadOpenPGP();
    const k = await pgp.readKey({ armoredKey: pub });
    return {
      privateArmor: priv,
      publicArmor: pub,
      fingerprint: k.getFingerprint().toUpperCase(),
      createdAt: k.getCreationTime?.() || null,
      algorithm: describeAlgo(k),
    };
  } catch { return null; }
}

function describeAlgo(k) {
  try {
    const info = k.getAlgorithmInfo();
    if (info.curve) return 'ECC ' + String(info.curve).replace('Legacy', '');
    if (info.bits) return 'RSA ' + info.bits;
    return String(info.algorithm || '');
  } catch { return ''; }
}

async function storeMyKey(email, privateArmor, publicArmor) {
  const e = norm(email);
  await secSet(ssName('priv', e), privateArmor);
  await secSet(ssName('pub', e), publicArmor);
}

export async function generateMyKey({ email, name, passphrase }) {
  const pgp = await loadOpenPGP();
  const { privateKey, publicKey } = await pgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: name || email, email }],
    passphrase,
    format: 'armored',
  });
  await storeMyKey(email, privateKey, publicKey);
  const k = await pgp.readKey({ armoredKey: publicKey });
  const fpr = k.getFingerprint().toUpperCase();
  let published = false;
  try { const r = await pgpKeyUpload(publicKey, fpr); published = !!r?.success; } catch {}
  forgetUnlocked();
  return { fingerprint: fpr, publicArmor: publicKey, published };
}

export async function publishMyKey(email) {
  const k = await getMyKey(email);
  if (!k) return false;
  try { const r = await pgpKeyUpload(k.publicArmor, k.fingerprint); return !!r?.success; } catch { return false; }
}

export async function deleteMyKey(email) {
  const e = norm(email);
  await secDel(ssName('priv', e)); await secDel(ssName('pub', e));
  forgetUnlocked();
  try { await pgpKeyDelete(); } catch {}
}

/** Restaura backup: precisa abrir com a senha (prova de posse) antes de gravar. */
export async function importPrivateBackup({ email, armored, passphrase }) {
  const pgp = await loadOpenPGP();
  let priv;
  try { priv = await pgp.readPrivateKey({ armoredKey: String(armored || '').trim() }); }
  catch { throw codeErr('invalid_key'); }
  try { await pgp.decryptKey({ privateKey: priv, passphrase }); }
  catch { throw codeErr('wrong_passphrase'); }
  const pub = priv.toPublic().armor();
  await storeMyKey(email, priv.armor(), pub);
  forgetUnlocked();
  try { await pgpKeyUpload(pub, priv.getFingerprint().toUpperCase()); } catch {}
  return { fingerprint: priv.getFingerprint().toUpperCase() };
}

function codeErr(code) { const e = new Error(code); e.code = code; return e; }

// ── chave destrancada em memória (15 min) ──
let _unlocked = null; // { email, key, until }
const UNLOCK_MS = 15 * 60 * 1000;
export function forgetUnlocked() { _unlocked = null; }
export function getUnlocked(email) {
  if (_unlocked && _unlocked.email === norm(email) && _unlocked.until > Date.now()) return _unlocked.key;
  _unlocked = null; return null;
}
export async function unlockMyKey(email, passphrase) {
  const mine = await getMyKey(email);
  if (!mine) throw codeErr('no_key');
  const pgp = await loadOpenPGP();
  const priv = await pgp.readPrivateKey({ armoredKey: mine.privateArmor });
  let key;
  try { key = await pgp.decryptKey({ privateKey: priv, passphrase }); }
  catch { throw codeErr('wrong_passphrase'); }
  _unlocked = { email: norm(email), key, until: Date.now() + UNLOCK_MS };
  return key;
}

// ── chaves de contatos ──
const contactsName = (me) => 'pgp_v2_contacts_' + norm(me);
export async function listContactKeys(me) {
  try { const raw = await AsyncStorage.getItem(contactsName(me)); const m = raw ? JSON.parse(raw) : {}; return m && typeof m === 'object' ? m : {}; }
  catch { return {}; }
}
export async function saveContactKey(me, armored) {
  const pgp = await loadOpenPGP();
  let k;
  try { k = await pgp.readKey({ armoredKey: String(armored || '').trim() }); } catch { throw codeErr('invalid_key'); }
  if (k.isPrivate()) throw codeErr('is_private');
  const ids = k.getUserIDs?.() || [];
  const m = /<([^>]+)>/.exec(ids[0] || '') || /([^\s<>]+@[^\s<>]+)/.exec(ids[0] || '');
  const email = norm(m ? m[1] : '');
  if (!email) throw codeErr('no_email');
  if (email === norm(me)) throw codeErr('is_own');
  const all = await listContactKeys(me);
  all[email] = { armor: k.armor(), fingerprint: k.getFingerprint().toUpperCase(), addedAt: Date.now(), name: ids[0] || email };
  await AsyncStorage.setItem(contactsName(me), JSON.stringify(all));
  return { email, fingerprint: all[email].fingerprint };
}
export async function removeContactKey(me, email) {
  const all = await listContactKeys(me);
  delete all[norm(email)];
  await AsyncStorage.setItem(contactsName(me), JSON.stringify(all));
}

/** Pública de alguém: importada no aparelho > publicada no Chatyy. */
export async function lookupPublicKey(me, target) {
  const t = norm(target);
  if (!t) return null;
  const pgp = await loadOpenPGP();
  if (t === norm(me)) {
    const mine = await getMyKey(me);
    return mine ? pgp.readKey({ armoredKey: mine.publicArmor }) : null;
  }
  const local = (await listContactKeys(me))[t];
  if (local?.armor) { try { return await pgp.readKey({ armoredKey: local.armor }); } catch {} }
  try {
    const r = await pgpKeyGet(t);
    if (r?.success && r.data?.found && r.data?.public_key_armor) return await pgp.readKey({ armoredKey: r.data.public_key_armor });
  } catch {}
  return null;
}

/**
 * Cifra p/ todos os destinatários + eu (p/ ler no Enviados). Assina quando a
 * chave estiver destrancada. Devolve { armored, missing:[emails sem chave], signed }.
 */
export async function encryptForRecipients({ me, text, recipients }) {
  const pgp = await loadOpenPGP();
  const uniq = Array.from(new Set((recipients || []).map(norm).filter(Boolean)));
  const keys = []; const missing = [];
  for (const r of uniq) {
    const k = await lookupPublicKey(me, r);
    if (k) keys.push(k); else missing.push(r);
  }
  if (missing.length) return { armored: '', missing, signed: false };
  const mine = await getMyKey(me);
  if (mine) { try { keys.push(await pgp.readKey({ armoredKey: mine.publicArmor })); } catch {} }
  const signer = getUnlocked(me);
  const message = await pgp.createMessage({ text: String(text || '') });
  const armored = await pgp.encrypt({ message, encryptionKeys: keys, ...(signer ? { signingKeys: signer } : {}) });
  return { armored, missing: [], signed: !!signer };
}

export const PGP_MSG_RE = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/;
export const PGP_SIGNED_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]+?-----END PGP SIGNATURE-----/;

/** Texto plano a partir do corpo do e-mail (o armor vem dentro de <pre>). */
export function emailPlainText(email) {
  const html = String(email?.body_html || '');
  if (html) {
    return html
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|pre|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  return String(email?.body_text || email?.body || '');
}

export function htmlToPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function verifyResult(pgp, signatures, senderKey) {
  if (!signatures || !signatures.length) return 'none';
  if (!senderKey) return 'unknown';
  try { await signatures[0].verified; return 'valid'; } catch { return 'invalid'; }
}

/** Decifra (e verifica assinatura do remetente quando houver). */
export async function decryptMessage({ me, armored, passphrase, senderEmail }) {
  const pgp = await loadOpenPGP();
  let key = getUnlocked(me);
  if (!key) {
    if (!passphrase) throw codeErr('need_passphrase');
    key = await unlockMyKey(me, passphrase);
  }
  let message;
  try { message = await pgp.readMessage({ armoredMessage: armored }); } catch { throw codeErr('invalid_message'); }
  const senderKey = senderEmail ? await lookupPublicKey(me, senderEmail).catch(() => null) : null;
  let out;
  try {
    out = await pgp.decrypt({ message, decryptionKeys: key, ...(senderKey ? { verificationKeys: senderKey } : {}) });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/session key|no.*key|decryption key|not.*encrypted.*for/i.test(msg)) throw codeErr('not_for_you');
    throw codeErr('decrypt_failed');
  }
  const signature = await verifyResult(pgp, out.signatures, senderKey);
  return { text: String(out.data || ''), signature };
}

/** Mensagem só assinada (clearsign). */
export async function verifyCleartext({ me, armored, senderEmail }) {
  const pgp = await loadOpenPGP();
  const message = await pgp.readCleartextMessage({ cleartextMessage: armored });
  const senderKey = senderEmail ? await lookupPublicKey(me, senderEmail).catch(() => null) : null;
  if (!senderKey) return { text: message.getText(), signature: 'unknown' };
  const v = await pgp.verify({ message, verificationKeys: senderKey });
  return { text: message.getText(), signature: await verifyResult(pgp, v.signatures, senderKey) };
}

export async function signCleartext({ me, text }) {
  const pgp = await loadOpenPGP();
  const key = getUnlocked(me);
  if (!key) throw codeErr('need_passphrase');
  const message = await pgp.createCleartextMessage({ text: String(text || '') });
  return pgp.sign({ message, signingKeys: key });
}

/** Autoteste ponta a ponta com a minha chave (cifra+assina → decifra+verifica). */
export async function selfTest({ me, passphrase }) {
  const pgp = await loadOpenPGP();
  const key = await unlockMyKey(me, passphrase);
  const mine = await getMyKey(me);
  const pub = await pgp.readKey({ armoredKey: mine.publicArmor });
  const sample = 'Chatyy PGP ' + Date.now();
  const enc = await pgp.encrypt({ message: await pgp.createMessage({ text: sample }), encryptionKeys: pub, signingKeys: key });
  const dec = await pgp.decrypt({ message: await pgp.readMessage({ armoredMessage: enc }), decryptionKeys: key, verificationKeys: pub, expectSigned: true });
  return dec.data === sample;
}

/** 0..4 — comprimento + variedade + penaliza padrões óbvios. */
export function passphraseStrength(p) {
  const s = String(p || '');
  if (!s) return 0;
  let score = 0;
  if (s.length >= 10) score++;
  if (s.length >= 14) score++;
  if (s.length >= 20) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(s)).length;
  if (classes >= 3) score++;
  const words = s.trim().split(/\s+/).filter(w => w.length >= 3).length;
  if (words >= 4) score++;
  if (/^(.)\1+$/.test(s) || /^(1234|abcd|qwer|senha|password|chatyy)/i.test(s) || /(0123|1234|2345|3456|4567|5678|6789)/.test(s)) score = Math.max(0, score - 2);
  if (s.length < 10) score = Math.min(score, 1);
  return Math.min(4, score);
}
export const MIN_PASSPHRASE = 10;
export function passphraseOk(p) { return String(p || '').length >= MIN_PASSPHRASE && passphraseStrength(p) >= 2; }

export function formatFingerprint(fpr) {
  const g = String(fpr || '').replace(/\s+/g, '').toUpperCase().match(/.{1,4}/g) || [];
  if (g.length <= 5) return g.join(' ');
  return g.slice(0, 5).join(' ') + '\n' + g.slice(5).join(' ');
}
