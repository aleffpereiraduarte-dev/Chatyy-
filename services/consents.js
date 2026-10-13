// [2026-10-13 consent-lgpd] Consentimentos LGPD + preferência de personalização.
//
// Fonte da verdade = servidor (email.php?action=consent_get|consent_set, tabela
// user_consents — log só-de-inserção com timestamp, versão do texto, canal,
// plataforma e IP truncado; ver /root/consentimento-servidor.sh). Aqui fica:
//   • cache local POR CONTA (chave com o e-mail — nunca vaza entre contas);
//   • escrita otimista + fila de pendentes (sem rede / servidor velho → reenvia
//     no próximo loadConsents);
//   • leitura SÍNCRONA p/ outras telas (Reels): isPersonalizationEnabled().
//
// Propósitos:
//   personalization  legítimo interesse (art. 7º IX) — LIGADO por padrão; false =
//                    o titular se opôs → feed por popularidade/cronológico.
//   chat_interests   consentimento específico — DESLIGADO por padrão (extração de
//                    temas NO APARELHO; recurso ainda desligado no produto — o
//                    switch só grava a preferência).
//   marketing        consentimento específico — DESLIGADO por padrão (ofertas do
//                    Chatyy e parceiros por push/e-mail/app).
//   terms            aceite dos Termos + Política (versão TERMS_VERSION).
//   terms_notice     ciência do aviso "Atualizamos nossos Termos".
//
// API p/ outros módulos (ex.: Reels — NÃO precisa importar mais nada):
//   isPersonalizationEnabled()      → boolean síncrono (padrão true até carregar)
//   isChatInterestsAllowed()        → boolean síncrono (padrão false)
//   feedPersonalizationParams()     → { personalized: 1|0 } p/ mandar no feed
//   subscribeConsents(fn)           → avisa quando muda (retorna unsubscribe)
//   loadConsents()                  → hidrata do disco + servidor (idempotente)
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiCall, getSavedEmail, getActiveAccountEmail } from './api';

// Versão dos Termos/Política em vigor. Trocar aqui + nos textos (legal.version) +
// CHATYY_TERMS_VERSION em consents-lib.php quando o texto mudar → aviso volta a aparecer.
export const TERMS_VERSION = '2026-10-13';
export const CONSENT_PURPOSES = ['personalization', 'chat_interests', 'marketing'];
const DEFAULTS = { personalization: true, chat_interests: false, marketing: false };
const KEY_PREFIX = 'chatyy_consents_v1:';

let _email = '';
let _state = null; // { purposes:{...}, termsVersion, noticeVersion, serverOk, pending:[] }
const _listeners = new Set();
let _loadP = null;
// Escolhas feitas antes de a conta estar ativa (corrida logo após o cadastro):
// esperam aqui e entram na fila da conta assim que ela aparecer.
let _orphanJobs = [];
let _orphanTimer = null;
function _adoptOrphansSoon(tries = 0) {
  if (_orphanTimer || !_orphanJobs.length) return;
  _orphanTimer = setTimeout(() => {
    _orphanTimer = null;
    if (_curEmail()) { loadConsents({ force: true }).catch(() => {}); return; }
    if (tries < 60) _adoptOrphansSoon(tries + 1);
  }, 1000);
}

function _blank() {
  return { purposes: { ...DEFAULTS }, termsVersion: null, noticeVersion: null, serverOk: false, pending: [] };
}
function _curEmail() {
  let e = '';
  try { e = String(getActiveAccountEmail() || ''); } catch {}
  if (!e) { try { e = String(getSavedEmail() || ''); } catch {} }
  return e.trim().toLowerCase();
}
function _appVersion() {
  try { return String(require('expo-constants').default?.expoConfig?.version || ''); } catch { return ''; }
}
function _platform() {
  return ['ios', 'android', 'web', 'macos', 'windows'].includes(Platform.OS) ? Platform.OS : 'other';
}
function _emit() {
  const snap = getConsentState();
  _listeners.forEach((fn) => { try { fn(snap); } catch {} });
}
async function _persist() {
  if (!_email || !_state) return;
  try { await AsyncStorage.setItem(KEY_PREFIX + _email, JSON.stringify(_state)); } catch {}
}
// Troca de conta → zera memória (nunca mostra a escolha de outra conta).
function _ensureAccount() {
  const e = _curEmail();
  if (e !== _email) { _email = e; _state = null; _loadP = null; }
  return e;
}
function _applyServer(data) {
  if (!data || typeof data !== 'object') return;
  const p = data.purposes || {};
  const next = { ...(_state?.purposes || DEFAULTS) };
  CONSENT_PURPOSES.forEach((k) => { if (p[k] && typeof p[k].granted === 'boolean') next[k] = p[k].granted; });
  // Pendentes ainda não confirmados prevalecem (escolha local mais nova).
  (_state?.pending || []).forEach((job) => (job.items || []).forEach((it) => {
    if (CONSENT_PURPOSES.includes(it.purpose)) next[it.purpose] = !!it.granted;
  }));
  _state = {
    ...(_state || _blank()),
    purposes: next,
    termsVersion: data.terms_version_accepted || _state?.termsVersion || null,
    noticeVersion: data.notice_version_seen || _state?.noticeVersion || null,
    serverOk: true,
  };
}
function _isUnsupported(r) {
  const m = String(r?.message || r?.error || '').toLowerCase();
  return !!r && r.success === false && (m.includes('unknown action') || m.includes('invalid action'));
}

async function _send(job) {
  try {
    const r = await apiCall('consent_set', {
      items: job.items,
      text_version: job.text_version,
      channel: job.channel,
      platform: job.platform,
      app_version: job.app_version,
    }, 'POST');
    if (r?.success) { _applyServer(r.data); return true; }
    // 4xx de validação não adianta reenviar; o resto (rede/503/servidor sem a action) fica na fila.
    const m = String(r?.message || '');
    if (/invalid|required/i.test(m) && !_isUnsupported(r)) return true;
    return false;
  } catch { return false; }
}

async function _flushPending() {
  if (!_state?.pending?.length) return;
  const queue = _state.pending.slice();
  const left = [];
  for (const job of queue) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await _send(job);
    if (!ok) left.push(job);
  }
  _state.pending = left.concat(_state.pending.slice(queue.length));
  await _persist();
}

async function _submit(items, channel) {
  const email = _ensureAccount();
  const job = {
    items, channel, text_version: TERMS_VERSION, platform: _platform(), app_version: _appVersion(),
    at: Date.now(),
  };
  if (!email) { _orphanJobs = [..._orphanJobs, job].slice(-10); _adoptOrphansSoon(); return false; }
  if (!_state) await loadConsents();
  // Otimista: a UI muda já; prova vai pro servidor (ou fica pendente).
  items.forEach((it) => {
    if (CONSENT_PURPOSES.includes(it.purpose)) _state.purposes[it.purpose] = !!it.granted;
    if (it.purpose === 'terms') _state.termsVersion = TERMS_VERSION;
    if (it.purpose === 'terms_notice') _state.noticeVersion = TERMS_VERSION;
  });
  _state.pending = [...(_state.pending || []), job].slice(-30);
  await _persist();
  _emit();
  await _flushPending();
  _emit();
  return !(_state.pending || []).includes(job);
}

// ---------------------------------------------------------------- leitura
export function getConsentState() {
  const s = _state || _blank();
  return {
    ...s.purposes,
    termsVersion: s.termsVersion,
    noticeVersion: s.noticeVersion,
    serverOk: !!s.serverOk,
    pendingCount: (s.pending || []).length,
    loaded: !!_state,
  };
}
export function isPersonalizationEnabled() {
  return _state ? _state.purposes.personalization !== false : DEFAULTS.personalization;
}
export function isChatInterestsAllowed() {
  return _state ? _state.purposes.chat_interests === true : DEFAULTS.chat_interests;
}
export function isMarketingAllowed() {
  return _state ? _state.purposes.marketing === true : DEFAULTS.marketing;
}
// Parâmetro p/ o feed de Reels (o servidor também pode consultar consentsGranted()).
export function feedPersonalizationParams() {
  return { personalized: isPersonalizationEnabled() ? 1 : 0 };
}
export function subscribeConsents(fn) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
export function useConsentState() {
  const [snap, setSnap] = useState(getConsentState);
  useEffect(() => {
    const off = subscribeConsents(setSnap);
    loadConsents().then(() => setSnap(getConsentState())).catch(() => {});
    return off;
  }, []);
  return snap;
}

// Disco (instantâneo) → servidor (verdade) → fila de pendentes.
export function loadConsents({ force = false } = {}) {
  const email = _ensureAccount();
  if (!email) return Promise.resolve(getConsentState());
  if (_loadP && !force) return _loadP.then(() => getConsentState());
  _loadP = (async () => {
    if (!_state) {
      try {
        const raw = await AsyncStorage.getItem(KEY_PREFIX + email);
        const saved = raw ? JSON.parse(raw) : null;
        _state = { ..._blank(), ...(saved || {}), purposes: { ...DEFAULTS, ...(saved?.purposes || {}) }, serverOk: false };
      } catch { _state = _blank(); }
      _emit();
    }
    if (_orphanJobs.length) {
      const adopt = _orphanJobs; _orphanJobs = [];
      _state.pending = [...(_state.pending || []), ...adopt].slice(-30);
      adopt.forEach((job) => (job.items || []).forEach((it) => {
        if (CONSENT_PURPOSES.includes(it.purpose)) _state.purposes[it.purpose] = !!it.granted;
        if (it.purpose === 'terms') _state.termsVersion = TERMS_VERSION;
      }));
      await _persist();
    }
    if (_curEmail() !== email) return getConsentState(); // trocou de conta no meio
    try {
      await _flushPending();
      const r = await apiCall('consent_get', {}, 'POST');
      if (_curEmail() !== email) return getConsentState();
      if (r?.success) { _applyServer(r.data); await _persist(); }
    } catch {}
    _emit();
    return getConsentState();
  })();
  const mine = _loadP;
  mine.catch(() => {}).finally(() => { setTimeout(() => { if (_loadP === mine) _loadP = null; }, 30_000); });
  return mine.then(() => getConsentState());
}

// ---------------------------------------------------------------- escrita
// Ajustes > Privacidade > Personalização e ofertas (e opções do aviso/cadastro).
export function setConsent(purpose, granted, channel = 'settings') {
  if (!CONSENT_PURPOSES.includes(purpose)) return Promise.resolve(false);
  return _submit([{ purpose, granted: !!granted }], channel);
}

// Cadastro (etapa final): prova do aceite dos Termos + as duas opções como foram
// mostradas (desmarcadas, salvo se o usuário marcou).
export function recordSignupConsents({ chat_interests = false, marketing = false } = {}) {
  return _submit([
    { purpose: 'terms', granted: true },
    { purpose: 'chat_interests', granted: !!chat_interests },
    { purpose: 'marketing', granted: !!marketing },
  ], 'signup');
}

// Aviso "Atualizamos nossos Termos": accepted=true (tocou Continuar) grava o aceite
// da versão nova; fechar só grava a ciência. As opções só são gravadas se mudaram.
export function recordTermsUpdate({ accepted = false, choices = {} } = {}) {
  const items = [{ purpose: 'terms_notice', granted: true }];
  if (accepted) items.push({ purpose: 'terms', granted: true });
  const cur = getConsentState();
  ['chat_interests', 'marketing'].forEach((k) => {
    if (typeof choices[k] === 'boolean' && choices[k] !== cur[k]) items.push({ purpose: k, granted: choices[k] });
  });
  return _submit(items, 'update_notice');
}

// Mostrar o aviso uma vez p/ quem já tinha conta: servidor respondeu, não aceitou
// a versão atual e ainda não viu o aviso dela. Servidor sem a action → não mostra
// (sem como registrar a prova).
export async function shouldShowTermsUpdate() {
  await loadConsents();
  const s = getConsentState();
  if (!s.serverOk) return false;
  if (s.termsVersion === TERMS_VERSION || s.noticeVersion === TERMS_VERSION) return false;
  return true;
}
