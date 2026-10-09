// signupSmarts — pure helpers for the phone-first signup (app/signup-phone.js).
// [2026-10-07 signup-ux]
//
// Kept free of React so they can be unit-checked with plain node:
//   • draft persistence (resume where the user left off — NO secrets: never
//     the OTP code, the password or the verify_token)
//   • phone paste/autofill parsing (+CC prefix → country switch)
//   • @username candidates from the display name + local validation
//   • password strength (signup-specific: penalises name/handle/phone reuse)
//   • server message → friendly i18n key mapping
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asciiDigits, cleanNationalDigits } from '../../constants/countries';

export const SIGNUP_DRAFT_KEY = 'chatyy_signup_draft_v1';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const DRAFT_FIELDS = ['countryCode', 'phone', 'firstName', 'lastName', 'username', 'avatarUri', 'reached'];

function _sanitizeDraft(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const k of DRAFT_FIELDS) {
    if (d[k] == null) continue;
    out[k] = String(d[k]).slice(0, k === 'avatarUri' ? 2048 : 80);
  }
  return out;
}

export async function loadSignupDraft() {
  try {
    const raw = await AsyncStorage.getItem(SIGNUP_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.savedAt || Date.now() - Number(d.savedAt) > DRAFT_TTL_MS) {
      AsyncStorage.removeItem(SIGNUP_DRAFT_KEY).catch(() => {});
      return null;
    }
    const clean = _sanitizeDraft(d);
    // Nothing worth resuming → treat as no draft.
    if (!clean.phone && !clean.firstName && !clean.username) return null;
    return clean;
  } catch { return null; }
}

export function saveSignupDraft(d) {
  try {
    const clean = _sanitizeDraft(d);
    if (!clean.phone && !clean.firstName && !clean.username) return;
    AsyncStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify({ ...clean, savedAt: Date.now() })).catch(() => {});
  } catch {}
}

export function clearSignupDraft() {
  try { AsyncStorage.removeItem(SIGNUP_DRAFT_KEY).catch(() => {}); } catch {}
}

// ── Phone ────────────────────────────────────────────────────────────────
// Turns whatever the user typed / pasted / got from iOS "tel" autofill into
// { countryCode, digits }. A leading "+" (or "00") means the text carries a
// dial code → pick the country with the LONGEST matching dial (prefers the
// current country when several share it, e.g. +1 US/CA). Without a "+" we
// only strip a duplicated dial code when the digits overflow the mask
// ("5511987654321" typed under BR) and a BR trunk "0" ("011 9…").
export function parsePhoneInput(text, currentCountry, countries) {
  const raw = asciiDigits(text || ''); // [2026-10-09 geo-qa] ٠٥٠ / ０９０ / ०९८ → ASCII
  const cur = countries.find(c => c.code === currentCountry) || countries[0];
  let digits = raw.replace(/\D/g, '');
  const trimmed = raw.trim();
  const intl = trimmed.startsWith('+') || (trimmed.startsWith('00') && digits.length > 10);
  if (intl) {
    if (trimmed.startsWith('00')) digits = digits.slice(2);
    let best = null;
    for (const c of countries) {
      const dd = String(c.dial || '').replace('+', '');
      if (!dd || !digits.startsWith(dd)) continue;
      if (!best || dd.length > best.dd.length || (dd.length === best.dd.length && c.code === cur.code)) best = { c, dd };
    }
    if (best) {
      // "+44 (0)7700…" → tira o 0 de tronco ANTES do corte em maxDigits.
      return { countryCode: best.c.code, digits: cleanNationalDigits(digits.slice(best.dd.length), best.c, { noDialStrip: true }) };
    }
  }
  // [2026-10-09 geo-qa] 0 de tronco tirado em TODOS os países (antes só BR) e
  // antes do corte — UK/FR/DE/JP/AU/NG/AE/ID/IN perdiam o último dígito.
  return { countryCode: cur.code, digits: cleanNationalDigits(digits, cur) };
}

// ── Username ────────────────────────────────────────────────────────────
function _slugPart(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Local mirror of the backend rule (/^[a-z0-9._-]+$/, 3..30) plus the RFC
// bits the backend doesn't enforce but that break the email address anyway:
// must start/end alphanumeric, no doubled separators.
export function usernameLocalError(u) {
  const v = String(u || '');
  if (v.length < 3) return 'short';
  if (v.length > 30) return 'long';
  if (!/^[a-z0-9._-]+$/.test(v)) return 'chars';
  if (!/^[a-z0-9]/.test(v) || !/[a-z0-9]$/.test(v)) return 'edges';
  if (/[._-]{2,}/.test(v)) return 'double';
  return null;
}

export function sanitizeUsernameTyping(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 30);
}

// Ordered handle ideas from the name: joao.silva, joaosilva, joao_silva,
// joao, jsilva, joao.silva + 2-digit year-ish suffix. All pass usernameLocalError.
export function usernameCandidates(firstName, lastName, seed) {
  const f = _slugPart(firstName).slice(0, 20);
  const l = _slugPart(String(lastName || '').trim().split(/\s+/).pop()).slice(0, 20);
  const n = String(seed == null ? new Date().getFullYear() % 100 : seed).padStart(2, '0');
  const out = [];
  const push = (s) => { if (s && !usernameLocalError(s) && !out.includes(s)) out.push(s.slice(0, 30)); };
  if (f && l) { push(`${f}.${l}`); push(`${f}${l}`); push(`${f}_${l}`); }
  push(f);
  if (f && l) push(`${f[0]}${l}`);
  if (f) push(`${f}${n}`);
  if (f && l) push(`${f}.${l}${n}`);
  return out;
}

// ── Password ────────────────────────────────────────────────────────────
const COMMON = ['123456', '12345678', 'password', 'senha', 'qwerty', 'abc123', '111111', 'iloveyou', 'admin', 'chatyy', 'contraseña', 'contrasena'];

// 0..4 → 0 = empty, 1 weak, 2 fair, 3 good, 4 strong. `ctx` = strings the
// password should not contain (name, handle, phone digits).
export function passwordScore(pw, ctx = []) {
  const p = String(pw || '');
  if (!p) return 0;
  if (p.length < 8) return 1;
  let s = 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter(r => r.test(p)).length;
  if (classes >= 2) s++;
  if (classes >= 3) s++;
  if (p.length >= 12) s++;
  if (p.length >= 16 && classes >= 2) s++;
  const low = p.toLowerCase();
  if (COMMON.some(c => low.includes(c))) s -= 2;
  if (/^(.)\1+$/.test(p) || /(0123|1234|2345|3456|4567|5678|6789|abcd)/i.test(p)) s -= 1;
  for (const c of ctx) {
    const v = String(c || '').toLowerCase();
    if (v.length >= 3 && low.includes(v)) { s -= 1; break; }
  }
  return Math.max(1, Math.min(4, s));
}

// ── Server → friendly i18n key ──────────────────────────────────────────
// Backend messages are hard-coded pt-BR (email.php phone_signup / verify_send).
// We map the ones a user can actually hit to translated keys; anything else
// keeps the server text (still better than a generic failure).
export function friendlyServerError(r, fallbackKey) {
  const msg = String(r?.message || '');
  const status = Number(r?.__httpStatus || r?.status || 0);
  const m = msg.toLowerCase();
  if (/username ja foi escolhido|username já foi escolhido/.test(m)) return { key: 'signupPhone.err.usernameTaken', kind: 'username' };
  if (/username reservado/.test(m)) return { key: 'signupPhone.err.usernameReserved', kind: 'username' };
  if (/username (muito curto|invalido|inválido|muito longo)/.test(m)) return { key: 'signupPhone.err.usernameInvalid', kind: 'username' };
  if (/telefone ja tem conta|telefone já tem conta/.test(m)) return { key: 'signupPhone.err.phoneHasAccount', kind: 'phone' };
  if (/verificacao expirada|verificação expirada|token de verificacao|verifique seu telefone/.test(m)) return { key: 'signupPhone.expired', kind: 'expired' };
  if (/senha curta/.test(m)) return { key: 'signupPhone.err.passwordShort', kind: 'password' };
  if (/muitas contas/.test(m)) return { key: 'signupPhone.err.tooManySignups', kind: 'rate' };
  if (status === 429 || /muitas (tentativas|requisi|solicita)|aguarde|too many/.test(m)) return { key: 'signupPhone.err.tooManyAttempts', kind: 'rate' };
  if (/invalido|inválido|invalid/.test(m) && /n[uú]mero|telefone|phone/.test(m)) return { key: 'login.phoneInvalid', kind: 'phone' };
  if (status >= 500) return { key: 'signupPhone.err.server', kind: 'server' };
  if (msg) return { text: msg, kind: 'other' };
  return { key: fallbackKey, kind: 'other' };
}
