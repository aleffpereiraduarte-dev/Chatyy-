// [e2ee5 WP-14 2026-10-21] Backup das chaves E2EE no servidor + restauração em aparelho novo.
//
// Contrato: docs/e2ee/CONTRATO.md §4.2.11–4.2.17 (backup_version_*, backup_keys_*, secret_storage_*),
// §6.8 (chave de recuperação base58 de 48 caracteres; senha opcional Argon2id m=64 MiB t=3 p=1 no
// núcleo), §1.4 (o backup restaura a MESMA identidade: o código de segurança não muda).
// Decisão do founder D5: backup OFERECIDO e OPCIONAL.
//
// O servidor guarda só: (a) as chaves Megolm cifradas com a chave PÚBLICA do backup e (b) MSK/SSK/USK
// + a chave privada do backup cifradas pela chave de recuperação (ou pela senha). Ele nunca vê nada
// em claro. A chave de recuperação NUNCA é gravada no aparelho nem logada: só é mostrada uma vez.
//
// FLAGS: `globalThis.__chatyy_e2ee5 === true` E (`e2ee5_status.flags.e2ee5_backup === true` OU
// `globalThis.__chatyy_e2ee5_backup === true` para QA). Desligado = nada aparece, nada roda.
import { Platform, AppState } from 'react-native';

const PUMP_MS = 3 * 60 * 1000;
const PASS_MIN = 12; // o núcleo recusa < 12
const DECLINE_KEY = 'e2ee5_restore_declined_v1';
const MODE_KEY = 'e2ee5_backup_mode_v1';

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _C() { return require('../crypto'); }
function _E() { return require('./e2ee5'); }
function _mm() { try { return require('../mmkv'); } catch (_) { return null; } }
function _log(what, kv) {
  try { if (_g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5-backup] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch (_) {}
}
function _err(code) { const e = new Error('e2ee5_backup:' + code); e.code = code; return e; }

export function isOn() { try { return _g().__chatyy_e2ee5 === true; } catch (_) { return false; } }
function _qa() { try { return _g().__chatyy_e2ee5_backup === true; } catch (_) { return false; } }

/** Backup liberado para a conta (síncrono, pelo último status da sessão). */
export function backupOnSync(status) {
  if (!isOn()) return false;
  if (_qa()) return true;
  try {
    const st = status || (_E().sessionSync() || {}).status;
    return !!(st && st.flags && st.flags.e2ee5_backup === true);
  } catch (_) { return false; }
}

// ───────────────────────────────────────────────────────────── preferências locais (sem segredo)

function _getJ(k) { try { const m = _mm(); return (m && m.getJSON(k)) || null; } catch (_) { return null; } }
function _setJ(k, v) { try { const m = _mm(); if (m) m.setJSON(k, v); } catch (_) {} }

/** Como o backup foi protegido neste aparelho: 'key' | 'password' | null (só para o texto da UI). */
export function protectionMode(uid) { const m = _getJ(MODE_KEY) || {}; return m[String(uid)] || null; }
function _setMode(uid, mode) { const m = _getJ(MODE_KEY) || {}; if (mode) m[String(uid)] = mode; else delete m[String(uid)]; _setJ(MODE_KEY, m); }

export function restoreDeclined(uid) { const m = _getJ(DECLINE_KEY) || {}; return !!m[String(uid)]; }
function _setDeclined(uid, v) { const m = _getJ(DECLINE_KEY) || {}; if (v) m[String(uid)] = Date.now(); else delete m[String(uid)]; _setJ(DECLINE_KEY, m); }

// ───────────────────────────────────────────────────────────── chave de recuperação (formatação)

/** "EsTk fXfy …" → grupos de 4 (o núcleo já devolve agrupado; normaliza por garantia). */
export function formatRecoveryKey(k) {
  const s = String(k || '').replace(/\s+/g, '');
  return s.replace(/(.{4})/g, '$1 ').trim();
}
export function recoveryGroups(k) { return formatRecoveryKey(k).split(' ').filter(Boolean); }

/** Sorteia 2 grupos distintos para o usuário confirmar que copiou a chave (índices 0-based). */
export function pickConfirmGroups(k) {
  const n = recoveryGroups(k).length;
  if (n < 2) return [0];
  const a = Math.floor(Math.random() * n);
  let b = Math.floor(Math.random() * (n - 1));
  if (b >= a) b += 1;
  return a < b ? [a, b] : [b, a];
}
export function checkConfirmGroups(k, idx, answers) {
  const g = recoveryGroups(k);
  return idx.every((i, j) => String(answers[j] || '').replace(/\s+/g, '') === g[i]);
}

/** Força da senha (≥12, com variedade e não óbvia). → {ok, reason} reason ∈ short|weak */
export function passwordStrength(p) {
  const s = String(p || '');
  if (s.length < PASS_MIN) return { ok: false, reason: 'short' };
  let kinds = 0;
  if (/[a-z]/.test(s)) kinds++;
  if (/[A-Z]/.test(s)) kinds++;
  if (/[0-9]/.test(s)) kinds++;
  if (/[^A-Za-z0-9]/.test(s)) kinds++;
  const uniq = new Set(s.split('')).size;
  const longPhrase = s.length >= 20 && /\s/.test(s.trim()); // frase longa com espaços também vale
  if ((kinds < 3 && !longPhrase) || uniq < 6 || /^(.)\1+$/.test(s) || /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|senha|password)/i.test(s)) return { ok: false, reason: 'weak' };
  return { ok: true };
}

// ───────────────────────────────────────────────────────────── estado

/**
 * → `{available, enabled, serverHasBackup, totalKeys, backedUpKeys, isPrimary, restorePending, mode, uid}`.
 * `available:false` = flag/coorte/aparelho sem núcleo (a seção some).
 */
export async function getState() {
  const z = { available: false, enabled: false, serverHasBackup: false, totalKeys: 0, backedUpKeys: 0, isPrimary: false, restorePending: false, mode: null, uid: '' };
  if (!isOn()) return z;
  const E = _E();
  const s = await E.ensureSession();
  if (!s || !backupOnSync(s.status)) return z;
  const C = _C();
  let st = null;
  try { st = await C.status(); if (st) s.status = st; } catch (_) { st = s.status; }
  let bs = null;
  try { bs = await C.backupStatus(); } catch (_) {}
  let isPrimary = false;
  try { const id = await C.identityStatus(s.uid); isPrimary = !!(id && id.isPrimary); } catch (_) {}
  const serverHasBackup = !!(st && st.has_backup);
  return {
    available: true,
    enabled: !!(bs && bs.enabled),
    serverHasBackup,
    totalKeys: Number(bs && bs.totalKeys) || 0,
    backedUpKeys: Number(bs && bs.backedUpKeys) || 0,
    isPrimary,
    restorePending: !s.signed && serverHasBackup && Platform.OS !== 'web',
    mode: protectionMode(s.uid),
    uid: s.uid,
  };
}

// ───────────────────────────────────────────────────────────── ligar / trocar / desligar

/**
 * Liga (ou troca) o backup. `passphrase` vazio = chave de recuperação aleatória (recomendado).
 * → `{recoveryKey, version}`: MOSTRAR uma vez e esquecer (nunca persistir/logar).
 */
export async function enable({ passphrase = '' } = {}) {
  if (!isOn()) throw _err('disabled');
  const s = await _E().ensureSession();
  if (!s || !backupOnSync(s.status)) throw _err('disabled');
  if (passphrase && !passwordStrength(passphrase).ok) throw _err('weak_password');
  const C = _C();
  // Trocar = desligar a versão anterior (zera o "já copiado" local) e criar outra.
  try { const bs = await C.backupStatus(); if (bs && bs.enabled) await C.backupDisable(); } catch (_) {}
  let r;
  try {
    r = await C.backupEnable(passphrase || '');
  } catch (e) {
    _log('enable_fail', { code: e && e.code });
    if (e && e.code === 'identity') throw _err('not_primary');
    if (e && e.code === 'invalid_input') throw _err('weak_password');
    if (e && (e.code === 'transport' || e.code === 'server')) throw _err('network');
    throw _err('failed');
  }
  _setMode(s.uid, passphrase ? 'password' : 'key');
  _setDeclined(s.uid, false);
  _armPump();
  _log('enabled', { version: r && r.version });
  return { recoveryKey: (r && r.recoveryKey) || '', version: (r && r.version) || '' };
}

/** Desliga: apaga a cópia do servidor. As chaves locais continuam. */
export async function disable() {
  if (!isOn()) throw _err('disabled');
  const s = await _E().ensureSession();
  if (!s) throw _err('disabled');
  try { await _C().backupDisable(); } catch (e) {
    _log('disable_fail', { code: e && e.code });
    throw _err(e && (e.code === 'transport' || e.code === 'server') ? 'network' : 'failed');
  }
  _setMode(s.uid, null);
  _log('disabled');
  return true;
}

// ───────────────────────────────────────────────────────────── envio incremental

let _pump = null;
let _pumpRunning = false;
let _appSub = null;

async function _pumpOnce(maxBatches) {
  if (_pumpRunning || !isOn()) return 0;
  const s = _E().sessionSync();
  if (!s || !s.signed || !backupOnSync(s.status)) return 0;
  _pumpRunning = true;
  try {
    const n = Number(await _C().backupStep(maxBatches)) || 0;
    if (n) _log('step', { batches: n });
    return n;
  } catch (e) {
    _log('step_fail', { code: e && e.code });
    return 0;
  } finally { _pumpRunning = false; }
}

/** Envia agora o que falta (UI de "Fazer backup agora"). → lotes enviados. */
export function backupNow() { return _pumpOnce(0); }

function _armPump() {
  if (_pump) return;
  try {
    _pump = setInterval(() => {
      try { if (AppState.currentState && AppState.currentState !== 'active') return; } catch (_) {}
      _pumpOnce(4).catch(() => {});
    }, PUMP_MS);
  } catch (_) {}
  try {
    _appSub = AppState.addEventListener('change', (st) => { if (st === 'background') _pumpOnce(2).catch(() => {}); });
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────── restaurar (aparelho novo / reinstalação)

/**
 * Restaura identidade + histórico. → `{imported, total, identityRestored}`.
 * Erros: 'wrong_key' | 'no_backup' | 'rate_limited' | 'network' | 'failed'.
 */
export async function restore(keyOrPassphrase) {
  if (!isOn()) throw _err('disabled');
  const E = _E();
  const s = await E.ensureSession();
  if (!s) throw _err('disabled');
  const input = String(keyOrPassphrase || '').trim();
  if (!input) throw _err('wrong_key');
  let r;
  try {
    r = await _C().backupRestore(input);
  } catch (e) {
    const d = (e && e.details) || {};
    const sc = String(d.server_code || d.code || '');
    _log('restore_fail', { code: e && e.code, sc });
    if (sc === 'e2ee5_no_backup') throw _err('no_backup');
    if (sc === 'e2ee5_rate_limited') throw _err('rate_limited');
    if (e && e.code === 'backup') throw _err(/errada|não confere|inválid/i.test(String(d.msg || '')) ? 'wrong_key' : 'failed');
    if (e && (e.code === 'transport' || e.code === 'server')) throw _err('network');
    throw _err('failed');
  }
  _setDeclined(s.uid, false);
  if (!protectionMode(s.uid)) _setMode(s.uid, /\s/.test(input) || input.length === 48 ? 'key' : 'password');
  // Reabre a sessão: agora o aparelho está assinado pela identidade restaurada.
  try { await E.endSession({ wipe: false }); } catch (_) {}
  try { await E.ensureSession(); } catch (_) {}
  try { E.requestSync(100); } catch (_) {}
  _armPump();
  _log('restored', { imported: r && r.imported, identity: !!(r && r.identityRestored) });
  return { imported: Number(r && r.imported) || 0, total: Number(r && r.total) || 0, identityRestored: !!(r && r.identityRestored) };
}

/** "Pular": segue como aparelho novo (identidade nova; contatos veem "o código de segurança mudou"). */
export async function declineRestore() {
  const E = _E();
  const s = E.sessionSync();
  const uid = s && s.uid;
  if (uid) _setDeclined(uid, true);
  try { await E.endSession({ wipe: false }); } catch (_) {}
  try { await E.ensureSession(); } catch (_) {}
  return true;
}

// ───────────────────────────────────────────────────────────── ganchos (chamados pelo e2ee5.js)

/**
 * Antes do `bootstrapIdentity` num celular sem identidade: se a conta tem backup no servidor e o
 * usuário ainda não escolheu "Pular", NÃO cria identidade nova (isso trocaria o código de segurança
 * e inutilizaria o backup) e oferece a restauração. → true = adiar o bootstrap.
 */
export function shouldDeferBootstrap(status) {
  try {
    if (!isOn() || Platform.OS === 'web') return false;
    if (!status || status.has_backup !== true || !backupOnSync(status)) return false;
    return !restoreDeclined(status.uid);
  } catch (_) { return false; }
}

let _offered = false;
/** Abre a tela de restauração uma vez por processo (o usuário pode pular). */
export function offerRestore() {
  if (_offered) return;
  _offered = true;
  setTimeout(() => {
    try {
      const { router } = require('expo-router');
      router.push('/e2ee-backup-restore');
    } catch (_) { _offered = false; }
  }, 1200);
}

/** Sessão aberta e assinada: liga o envio incremental se o backup estiver ativo. */
export function onSession(sess) {
  if (!isOn() || !sess || !sess.signed || !backupOnSync(sess.status)) return;
  _C().backupStatus().then((bs) => { if (bs && bs.enabled) { _armPump(); _pumpOnce(4).catch(() => {}); } }).catch(() => {});
}

const backup = {
  isOn, backupOnSync, getState, enable, disable, restore, declineRestore, backupNow, formatRecoveryKey, recoveryGroups,
  pickConfirmGroups, checkConfirmGroups, passwordStrength, protectionMode, restoreDeclined, shouldDeferBootstrap,
  offerRestore, onSession,
};
export default backup;
