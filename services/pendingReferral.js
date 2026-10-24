// [bia-convite 2026-10-19] Código de convite ("ref") pendente.
//
// Links https://chatyy.com.br/signup?ref=CODE e onemundomail://signup?ref=CODE
// gravam o código UMA vez (o 1º link vale: não sobrescreve) com validade de
// 30 dias. O cadastro (signup / phone_signup / username_signup) manda `ref`
// e limpa ao dar certo. Fallback: depois de cadastro ou login, se ainda houver
// código pendente, chama apply_referral uma vez e limpa em qualquer resposta
// definitiva (aplicado / já tinha / inválido / próprio código / conta antiga).
// Servidor sem o kit (apply_referral inexistente) ou erro de rede = mantém o
// código para a próxima sessão (até vencer os 30 dias).
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pending_ref';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-Z0-9]{4,32}$/;
const DEFINITIVE = new Set([
  'applied', 'already_applied', 'already_referred', 'invalid_code', 'self_referral',
  'account_too_old', 'account_age_unknown', 'cycle', 'missing_code',
]);

export function normalizeRefCode(raw) {
  const c = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return CODE_RE.test(c) ? c : '';
}

function _queryParam(url, name) {
  const q = String(url).split('#')[0];
  const i = q.indexOf('?');
  if (i < 0) return '';
  const parts = q.slice(i + 1).split('&');
  for (const kv of parts) {
    const j = kv.indexOf('=');
    const k = j >= 0 ? kv.slice(0, j) : kv;
    if (k === name) {
      try { return decodeURIComponent((j >= 0 ? kv.slice(j + 1) : '').replace(/\+/g, ' ')); } catch { return kv.slice(j + 1); }
    }
  }
  return '';
}

// Código de um link de cadastro: chatyy.com.br/signup?ref=, onemundomail://signup?ref=,
// ou um caminho do expo-router ("/signup?ref=", "signup?ref="). Também aceita
// /signup-phone e /signup-username. Qualquer outro link → ''.
export function refFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const s = url.trim();
  let path = '';
  const https = s.match(/^https?:\/\/(?:www\.)?(?:chatyy\.com\.br|chatyy\.app)(\/[^?#]*)?/i);
  if (https) path = https[1] || '/';
  else if (/^onemundomail:\/\//i.test(s)) path = '/' + s.replace(/^onemundomail:\/\//i, '').replace(/^\/+/, '').split(/[?#]/)[0];
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) path = '/' + s.replace(/^\/+/, '').split(/[?#]/)[0];
  else return '';
  path = path.replace(/\/+$/, '').toLowerCase();
  if (path !== '/signup' && path !== '/signup-phone' && path !== '/signup-username') return '';
  return normalizeRefCode(_queryParam(s, 'ref'));
}

async function _read() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const code = normalizeRefCode(o && o.code);
    const ts = Number(o && o.ts) || 0;
    if (!code || !ts || Date.now() - ts > TTL_MS) {
      try { await AsyncStorage.removeItem(KEY); } catch {}
      return null;
    }
    return { code, ts };
  } catch { return null; }
}

/** Código pendente válido (ou '' se nenhum / vencido). */
export async function getPendingRef() {
  const o = await _read();
  return o ? o.code : '';
}

export async function clearPendingRef() {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

/** Grava o código se ainda não houver um válido. Devolve true se gravou agora. */
export async function storePendingRef(raw) {
  const code = normalizeRefCode(raw);
  if (!code) return false;
  try {
    if (await _read()) return false; // 1º link vale: não sobrescreve
    await AsyncStorage.setItem(KEY, JSON.stringify({ code, ts: Date.now() }));
  } catch { return false; }
  _applySoonIfLoggedIn();
  return true;
}

/** Captura o ref de um link recebido (deep link / universal link). Nunca lança. */
export function captureRefFromUrl(url) {
  try {
    const code = refFromUrl(url);
    if (code) storePendingRef(code).catch(() => {});
    return code;
  } catch { return ''; }
}

// Link aberto com a sessão já logada → tenta aplicar logo (conta nova que já
// entrou por outro caminho; conta antiga recebe "conta antiga" e o código some).
function _applySoonIfLoggedIn() {
  try {
    const api = require('./api');
    if (!api.getAuthToken?.()) return;
    setTimeout(() => { applyPendingReferral().catch(() => {}); }, 3000);
  } catch {}
}

let _inFlight = null;
let _triedThisSession = '';

/**
 * Fallback pós-cadastro/login: aplica o código pendente uma vez por sessão.
 * @returns {Promise<null | { reason: string, applied: boolean, code: string }>}
 */
export function applyPendingReferral() {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const code = await getPendingRef();
    if (!code) return null;
    let token = '';
    try { token = require('./api').getAuthToken?.() || ''; } catch {}
    if (!token) return null;
    const sessKey = code + '|' + String(token).slice(-12);
    if (_triedThisSession === sessKey) return null;
    _triedThisSession = sessKey;
    const r = await applyReferralCode(code);
    if (r.definitive) await clearPendingRef();
    return { reason: r.reason, applied: r.applied, code };
  })().catch(() => null).finally(() => { _inFlight = null; });
  return _inFlight;
}

/**
 * Chama apply_referral e classifica a resposta.
 * reason: applied | already_applied | already_referred | invalid_code | self_referral |
 *         account_too_old | account_age_unknown | cycle | missing_code | rate_limited |
 *         unsupported (servidor sem o kit) | network | error
 */
export async function applyReferralCode(rawCode) {
  const code = normalizeRefCode(rawCode);
  if (!code) return { reason: 'invalid_code', applied: false, definitive: true, maxDays: 0 };
  let r = null;
  try { r = await require('./api').applyReferral(code); } catch { return { reason: 'network', applied: false, definitive: false, maxDays: 0 }; }
  const d = (r && r.data && typeof r.data === 'object') ? r.data : {};
  const maxDays = Number(d.max_days) || 0;
  let reason = String(d.reason || '');
  if (r && r.success) reason = reason || 'applied';
  if (!reason) {
    const msg = String((r && (r.message || r.error)) || '');
    reason = /unknown action|acao desconhecida|ação desconhecida/i.test(msg) ? 'unsupported' : (r && r.offline ? 'network' : 'error');
  }
  const applied = !!(r && r.success && (d.applied !== false));
  return { reason, applied, definitive: DEFINITIVE.has(reason), maxDays };
}
