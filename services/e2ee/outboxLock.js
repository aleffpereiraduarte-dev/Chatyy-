// [2026-10-22 e2ee5 nunca-perder] Cofre LOCAL do texto digitado numa conversa E2EE v5 enquanto ele
// ainda não virou envelope persistido (fila nativa / linha do outbox / servidor).
//
// Antes: a linha do outbox (SQLite) era gravada SEM o texto (outboxScrub) e o envelope só existia na
// memória do JS ou na fila nativa → reload (OTA/banner/crash) no meio do envio = linha sem nada →
// boot marcava "não enviada" (e2ee_not_encrypted) e a mensagem se perdia.
// Agora a linha guarda `e2e_lock` = texto CIFRADO em repouso com uma chave do aparelho (32 B) que vive
// no Keychain/Keystore (expo-secure-store, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: não vai para backup
// nem para outro aparelho). Cifra: XSalsa20-Poly1305 (tweetnacl secretbox — AEAD já usado pelo app;
// não há AES-GCM nativo no Hermes). O cmid entra no texto claro selado e é conferido ao abrir (um
// cofre não serve noutra linha). Nunca texto puro em AsyncStorage/SQLite.
// O worker abre o cofre no boot, CIFRA com a sessão E2EE e troca pelo envelope (e2e_lock some).
import { Platform } from 'react-native';

const SS_KEY = 'chatyy_e2ee5_outbox_lock_v1';
let _key = null; // Uint8Array(32)
let _keyP = null;

function _nacl() { return require('tweetnacl'); }
function _u() { return require('tweetnacl-util'); }
function _ss() { try { return require('expo-secure-store'); } catch (_) { return null; } }
// bytes aleatórios SEGUROS (nunca Math.random): Web Crypto (Hermes/expo) → expo-crypto. null = sem fonte.
function _rand(n) {
  try { const c = globalThis.crypto; if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint8Array(n)); } catch (_) {}
  try { const C = require('expo-crypto'); if (C && typeof C.getRandomBytes === 'function') { const b = C.getRandomBytes(n); if (b && b.length === n) return Uint8Array.from(b); } } catch (_) {}
  return null;
}

/** Carrega (ou cria e grava) a chave do aparelho. null = indisponível (sem Keychain). */
export function loadKey() {
  if (_key) return Promise.resolve(_key);
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (!_keyP) {
    _keyP = (async () => {
      const SS = _ss();
      if (!SS || typeof SS.getItemAsync !== 'function') return null;
      const U = _u();
      let b64 = null;
      try { b64 = await SS.getItemAsync(SS_KEY); } catch (_) { b64 = null; }
      if (b64) {
        try { const k = U.decodeBase64(b64); if (k && k.length === 32) { _key = k; return k; } } catch (_) {}
      }
      // primeira vez (ou valor ilegível): chave nova — só passa a valer depois de GRAVADA e relida
      // (cofre com chave que não sobrevive ao reload seria pior que nada).
      const k = _rand(32);
      if (!k) return null;
      const opt = SS.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY != null ? { keychainAccessible: SS.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY } : undefined;
      try {
        await SS.setItemAsync(SS_KEY, U.encodeBase64(k), opt);
        const back = await SS.getItemAsync(SS_KEY);
        if (back !== U.encodeBase64(k)) return null;
      } catch (_) { return null; }
      _key = k;
      return k;
    })().catch(() => null).then((k) => { if (!k) _keyP = null; return k; });
  }
  return _keyP;
}

export function keyReadySync() { return !!_key; }

function _seal(key, text, cmid) {
  const N = _nacl(); const U = _u();
  const n = _rand(N.secretbox.nonceLength);
  if (!n) throw new Error('no_rng');
  const pt = U.decodeUTF8(JSON.stringify({ c: String(cmid || ''), t: String(text) }));
  const ct = N.secretbox(pt, n, key);
  return { v: 1, n: U.encodeBase64(n), c: U.encodeBase64(ct) };
}

/** Cofre síncrono (só com a chave já carregada). null = sem chave. */
export function lockSync(text, cmid) {
  if (!_key || typeof text !== 'string' || !text) return null;
  try { return _seal(_key, text, cmid); } catch (_) { return null; }
}

export async function lock(text, cmid) {
  if (typeof text !== 'string' || !text) return null;
  const k = await loadKey();
  if (!k) return null;
  try { return _seal(k, text, cmid); } catch (_) { return null; }
}

/** Abre o cofre da linha `cmid`. null = chave ausente/cofre adulterado/de outra linha. */
export async function unlock(blob, cmid) {
  if (!blob || typeof blob !== 'object' || blob.v !== 1 || !blob.n || !blob.c) return null;
  const k = await loadKey();
  if (!k) return null;
  try {
    const N = _nacl(); const U = _u();
    const pt = N.secretbox.open(U.decodeBase64(blob.c), U.decodeBase64(blob.n), k);
    if (!pt) return null;
    const o = JSON.parse(U.encodeUTF8(pt));
    if (!o || typeof o.t !== 'string') return null;
    if (cmid != null && String(o.c || '') !== String(cmid)) return null;
    return o.t;
  } catch (_) { return null; }
}

/** Testes: zera o cache em memória (simula processo novo). */
export function _resetForTest() { _key = null; _keyP = null; }

// aquece a chave cedo (o 1º envio já sai com cofre síncrono)
try { if (Platform.OS !== 'web') setTimeout(() => { loadKey().catch(() => {}); }, 0); } catch (_) {}

export default { loadKey, keyReadySync, lockSync, lock, unlock };
