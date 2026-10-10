/**
 * E2EE v4 — adaptador do módulo nativo (iOS/Android). [2026-10-10]
 *
 * Expõe a MESMA forma de `V` que o wasm do web (vendor/chatyy-e2ee/vodozemac.js)
 * para o núcleo services/e2eeV4Core.js rodar sem mudança:
 *   new V.OlmAccount() · V.OlmAccount.fromPickle(p, key32) · acct.pickle(key32)
 *   acct.curve25519 / acct.ed25519 (getters) · acct.sign · generateOneTimeKeys
 *   oneTimeKeys() · generateFallbackKey · fallbackKey() · markKeysAsPublished
 *   maxOneTimeKeys · createOutboundSession → OlmSession
 *   createInboundSession → { plaintext, takeSession() }
 *   V.OlmSession.fromPickle · s.pickle · s.sessionId (getter) · s.encrypt · s.decrypt
 *   V.ed25519Verify · V.preKeySessionId · MegolmOutbound / MegolmInbound · x.free()
 *
 * O módulo nativo (native/e2ee/expo-chatyy-e2ee → 'ChatyyE2EE') guarda os
 * objetos Rust (vodozemac via UniFFI) num mapa de handles; aqui só há classes
 * finas por cima. Nenhuma criptografia em JS.
 *
 * SEGURO NO BINÁRIO ATUAL: requireOptionalNativeModule devolve null quando o
 * módulo não está no app → nativeE2EEAvailable() = false e nada mais roda.
 */

let _N; // undefined = ainda não procurou; null = não existe

function _load() {
  if (_N !== undefined) return _N;
  _N = null;
  try {
    // require preguiçoso: este arquivo também é importado por testes em Node.
    // eslint-disable-next-line global-require
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule('ChatyyE2EE');
    if (m && typeof m.available === 'function' && m.available()) _N = m;
  } catch { _N = null; }
  return _N;
}

export function nativeE2EEAvailable() { return !!_load(); }

export function nativeE2EEVersion() {
  const N = _load();
  try { return N ? N.coreVersion() : null; } catch { return null; }
}

// ---------- bytes ↔ base64 (sem Buffer; Hermes tem btoa/atob) ----------
function bytesToB64(u8) {
  if (typeof u8 === 'string') return u8;
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Monta o `V` em cima de um objeto com a API do módulo nativo. Separado de
 * _load() para os testes injetarem um módulo falso (native/e2ee/js-test).
 */
export function makeV(N) {
  if (!N) throw new Error('e2ee_unsupported');

  const freeHandle = (h) => { if (h) { try { N.free(h); } catch {} } };

  class OlmSession {
    constructor(handle) { this._h = handle; }
    static fromPickle(pickle, key) { return new OlmSession(N.sessionFromPickle(pickle, bytesToB64(key))); }
    pickle(key) { return N.sessionPickle(this._h, bytesToB64(key)); }
    get sessionId() { return N.sessionId(this._h); }
    encrypt(plaintext) { return N.sessionEncrypt(this._h, String(plaintext)); }
    decrypt(t, b) { return N.sessionDecrypt(this._h, Number(t), String(b)); }
    free() { freeHandle(this._h); this._h = 0; }
  }

  class OlmAccount {
    constructor(handle) { this._h = handle || N.accountNew(); }
    static fromPickle(pickle, key) { return new OlmAccount(N.accountFromPickle(pickle, bytesToB64(key))); }
    pickle(key) { return N.accountPickle(this._h, bytesToB64(key)); }
    get curve25519() { return N.accountCurve25519(this._h); }
    get ed25519() { return N.accountEd25519(this._h); }
    sign(message) { return N.accountSign(this._h, String(message)); }
    generateOneTimeKeys(count) { N.accountGenerateOneTimeKeys(this._h, Number(count) | 0); }
    oneTimeKeys() { return N.accountOneTimeKeys(this._h); }
    generateFallbackKey() { N.accountGenerateFallbackKey(this._h); }
    fallbackKey() { return N.accountFallbackKey(this._h); }
    markKeysAsPublished() { N.accountMarkKeysAsPublished(this._h); }
    maxOneTimeKeys() { return N.accountMaxOneTimeKeys(this._h); }
    createOutboundSession(identityKey, oneTimeKey) {
      return new OlmSession(N.accountCreateOutboundSession(this._h, identityKey, oneTimeKey));
    }
    createInboundSession(theirIdentityKey, t, b) {
      const r = N.accountCreateInboundSession(this._h, theirIdentityKey, Number(t), String(b));
      let session = new OlmSession(r.session);
      // Igual ao wasm: o chamador pega a sessão uma vez; se não pegar, o handle
      // é liberado no free() do resultado.
      return {
        plaintext: r.plaintext,
        takeSession() { const s = session; session = null; return s; },
        free() { if (session) { session.free(); session = null; } },
      };
    }
    free() { freeHandle(this._h); this._h = 0; }
  }

  class MegolmOutbound {
    constructor(handle) { this._h = handle || N.megolmOutboundNew(); }
    static fromPickle(pickle, key) { return new MegolmOutbound(N.megolmOutboundFromPickle(pickle, bytesToB64(key))); }
    pickle(key) { return N.megolmOutboundPickle(this._h, bytesToB64(key)); }
    get sessionId() { return N.megolmOutboundSessionId(this._h); }
    sessionKey() { return N.megolmOutboundSessionKey(this._h); }
    encrypt(plaintext) { return N.megolmOutboundEncrypt(this._h, String(plaintext)); }
    free() { freeHandle(this._h); this._h = 0; }
  }

  class MegolmInbound {
    constructor(sessionKey, handle) { this._h = handle || N.megolmInboundNew(sessionKey); }
    static fromPickle(pickle, key) { return new MegolmInbound(null, N.megolmInboundFromPickle(pickle, bytesToB64(key))); }
    pickle(key) { return N.megolmInboundPickle(this._h, bytesToB64(key)); }
    get sessionId() { return N.megolmInboundSessionId(this._h); }
    decrypt(message) { return N.megolmInboundDecrypt(this._h, String(message)); }
    free() { freeHandle(this._h); this._h = 0; }
  }

  return {
    OlmAccount,
    OlmSession,
    MegolmOutbound,
    MegolmInbound,
    ed25519Verify: (pk, msg, sig) => !!N.ed25519Verify(String(pk || ''), String(msg || ''), String(sig || '')),
    preKeySessionId: (t, b) => N.preKeySessionId(Number(t), String(b || '')),
  };
}

/**
 * O núcleo usa globalThis.crypto.getRandomValues (chave de pickle, ids) e
 * crypto.subtle.digest('SHA-512') (número de segurança). O Hermes não tem os
 * dois: completa SÓ o que falta, com o gerador do sistema (SecRandom /
 * SecureRandom) e SHA-512 nativos. Nunca substitui o que já existe.
 */
export function ensureCryptoPolyfills(N) {
  const g = globalThis;
  if (!g.crypto) g.crypto = {};
  if (typeof g.crypto.getRandomValues !== 'function') {
    g.crypto.getRandomValues = (arr) => {
      const n = arr.byteLength;
      if (n > 65536) throw new Error('getRandomValues: quota');
      const bytes = b64ToBytes(N.randomBytes(n));
      new Uint8Array(arr.buffer, arr.byteOffset, n).set(bytes);
      return arr;
    };
  }
  if (!g.crypto.subtle || typeof g.crypto.subtle.digest !== 'function') {
    const subtle = g.crypto.subtle || {};
    subtle.digest = async (algo, data) => {
      const name = typeof algo === 'string' ? algo : algo?.name;
      if (String(name).toUpperCase() !== 'SHA-512') throw new Error(`digest: ${name} não suportado`);
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
      return b64ToBytes(N.sha512(bytesToB64(u8))).buffer;
    };
    g.crypto.subtle = subtle;
  }
}

/** V pronto para o núcleo, ou lança e2ee_unsupported (binário sem o módulo). */
export function getNativeV() {
  const N = _load();
  if (!N) {
    const e = new Error('e2ee_unsupported');
    e.code = 'e2ee_unsupported';
    throw e;
  }
  ensureCryptoPolyfills(N);
  return makeV(N);
}
