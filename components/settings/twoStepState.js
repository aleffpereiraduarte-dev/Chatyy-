// [2026-10-16 two-step] Estado da "Verificação em duas etapas" (PIN = o mesmo
// registration_lock que o login por telefone exige após o OTP — anti-SIM-swap).
// Guarda por conta (AsyncStorage) o último status do servidor + agenda do
// lembrete periódico (estilo WhatsApp: pede o PIN de vez em quando). Nunca
// guarda o PIN — só flags/datas. Assinável: a linha de Conta e o lembrete
// atualizam juntos quando a folha liga/desliga.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiCall } from '../../services/api';

export const TWO_STEP_REMIND_MS = 7 * 24 * 3600 * 1000;
export const TWO_STEP_SNOOZE_MS = 24 * 3600 * 1000;
const STATUS_TTL_MS = 24 * 3600 * 1000;

const lc = (e) => String(e || '').trim().toLowerCase();
const KEY = (e) => `chatyy.twostep.v1:${lc(e)}`;
const _mem = new Map();
const _subs = new Set();

export function subscribeTwoStep(fn) { _subs.add(fn); return () => { _subs.delete(fn); }; }
export function getCachedTwoStep(email) { return _mem.get(lc(email)) || null; }

export async function loadTwoStep(email) {
  if (!email) return null;
  const m = _mem.get(lc(email));
  if (m) return m;
  try {
    const raw = await AsyncStorage.getItem(KEY(email));
    const s = raw ? JSON.parse(raw) : null;
    if (s && typeof s === 'object') { _mem.set(lc(email), s); return s; }
  } catch {}
  return null;
}

export async function saveTwoStep(email, patch) {
  if (!email) return null;
  const prev = (await loadTwoStep(email)) || {};
  const next = { ...prev, ...patch };
  _mem.set(lc(email), next);
  try { await AsyncStorage.setItem(KEY(email), JSON.stringify(next)); } catch {}
  _subs.forEach((fn) => { try { fn(lc(email), next); } catch {} });
  return next;
}

// Normaliza o payload do servidor (get_2fa_status / enable_2fa / disable_2fa)
// e reagenda o lembrete: ligou agora / trocou PIN → próximo em 7 dias; já
// estava ligado sem agenda local → 7 dias após set_at; desligou → sem agenda.
export async function applyServerStatus(email, data, { resetReminder = false } = {}) {
  if (!email || !data || typeof data !== 'object') return null;
  const prev = (await loadTwoStep(email)) || {};
  const enabled = !!(data.enabled ?? data.pin_enabled);
  let next = prev.next || null;
  if (!enabled) next = null;
  else if (resetReminder || !next) {
    const setAt = Date.parse(data.set_at || '');
    next = (!resetReminder && Number.isFinite(setAt)) ? setAt + TWO_STEP_REMIND_MS : Date.now() + TWO_STEP_REMIND_MS;
  }
  return saveTwoStep(email, {
    enabled,
    hasEmail: !!data.has_recovery_email,
    emailMasked: data.recovery_email_masked || null,
    next,
    remind: prev.remind !== false,
    fetchedAt: Date.now(),
  });
}

export async function fetchTwoStep(email, { maxAgeMs = 0 } = {}) {
  if (!email) return null;
  if (maxAgeMs > 0) {
    const cur = await loadTwoStep(email);
    if (cur && cur.fetchedAt && Date.now() - cur.fetchedAt < maxAgeMs) return cur;
  }
  try {
    const r = await apiCall('get_2fa_status', {}, 'GET', { swr: false });
    if (r && r.success && r.data) return applyServerStatus(email, r.data);
  } catch {}
  return loadTwoStep(email);
}
export const fetchTwoStepIfStale = (email) => fetchTwoStep(email, { maxAgeMs: STATUS_TTL_MS });

// Respostas do servidor: 403 {current_pin_required} = PIN atual errado/ausente;
// 429 (rate_limited ou "Muitas tentativas") = espera; 400 de e-mail.
// O apiCall devolve só o corpo JSON, então classificamos pelo conteúdo.
export function twoStepError(r) {
  const d = (r && r.data) || {};
  const msg = String((r && r.message) || '');
  // [wave13e] reset por e-mail: código errado / expirado / sem e-mail cadastrado.
  if (d.reset_expired) return 'expired';
  if (d.code_invalid) return 'code';
  if (d.no_recovery_email) return 'noEmail';
  if (d.rate_limited || /muitas tentativas|too many/i.test(msg)) return 'rate';
  if (d.current_pin_required) return 'wrong';
  if (/e-?mail/i.test(msg)) return 'email';
  if (/4 a 6/.test(msg)) return 'format';
  return 'generic';
}

// Ações (apiCall genérico — o wrapper antigo enable2fa/disable2fa não manda
// current_pin/recovery_email).
export function twoStepEnable({ pin, currentPin, recoveryEmail } = {}) {
  const p = { pin };
  if (currentPin) p.current_pin = currentPin;
  if (recoveryEmail !== undefined) p.recovery_email = recoveryEmail;
  return apiCall('enable_2fa', p, 'POST');
}
export function twoStepDisable(currentPin) {
  return apiCall('disable_2fa', { current_pin: currentPin }, 'POST');
}
function _unknownAction(r) {
  return !!(r && r.success === false && /unknown action|a[cç][aã]o (desconhecida|inv[aá]lida)|invalid action/i.test(String(r.message || r.error || '')));
}

// [wave13e 2026-10-16] Confere o PIN sem mudar nada: verify_2fa_pin (o
// servidor NÃO regrava hash/set_at e o limite conta só os erros). Servidor
// antigo sem a ação → caminho antigo (regrava o MESMO PIN provando o atual).
export async function twoStepVerify(pin) {
  const r = await apiCall('verify_2fa_pin', { pin }, 'POST');
  if (_unknownAction(r)) return apiCall('enable_2fa', { pin, current_pin: pin }, 'POST');
  return r;
}

// [wave13e] "Esqueci meu PIN": código de 6 dígitos (1 h, uso único) no e-mail
// de recuperação; confirmar desliga a verificação em duas etapas.
export function twoStepResetRequest() {
  return apiCall('reset_2fa_request', {}, 'POST');
}
export function twoStepResetConfirm(code) {
  return apiCall('reset_2fa_confirm', { code: String(code || '') }, 'POST');
}
