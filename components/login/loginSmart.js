// [2026-10-07 login-ux] Pure helpers behind the smart login identifier field.
//
// One field accepts phone, e-mail or @username (Instagram/Telegram pattern).
// Everything here is side-effect free except the tiny AsyncStorage wrappers at
// the bottom (last identifier), so it is safe on web + native and trivially
// testable with plain node.
import { Platform } from 'react-native';
import { COUNTRIES, asciiDigits } from '../../constants/countries';

export const DEFAULT_DOMAIN = 'chatyy.com.br';

// 'empty' | 'phone' | 'email' | 'username'
//  - leading "@"              → username (Instagram handle style)
//  - contains "@"             → email
//  - only digits + phone punctuation (+ ( ) - . space) → phone
//  - anything else            → username (bare handle → handle@chatyy.com.br)
export function classifyIdentifier(raw) {
  const v = asciiDigits(raw || '').trim();
  if (!v) return 'empty';
  if (v.startsWith('@')) return 'username';
  if (v.includes('@')) return 'email';
  // [2026-10-09 geo-qa] hífens/traços Unicode (‐ ‑ ‒ – — − ー －, autofill do
  // iOS e teclados JP/AR) e "/" (DE "0151/2345…") também são pontuação de
  // telefone; antes "11 98765‑4321" virava username.
  if (/^[+(]?[\d\s().\/\-\u2010-\u2015\u2212\u30FC\uFF0D]+$/.test(v) && /\d/.test(v)) return 'phone';
  return 'username';
}

// E-mail/username → canonical login e-mail. Strips ALL whitespace (a trailing
// space from iOS autocorrect / paste was a top cause of "senha incorreta"),
// drops the "@" handle prefix and lowercases (Dovecot lowercases the user on
// auth anyway, so this only fixes the session/mailbox key, never the outcome).
export function normalizeLoginEmail(raw) {
  let v = String(raw || '').replace(/\s+/g, '').toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  if (!v) return '';
  return v.includes('@') ? v : `${v}@${DEFAULT_DOMAIN}`;
}

export function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''));
}

// Soft warnings shown while typing (never block submit).
export function identifierHints(raw) {
  const s = String(raw || '');
  const kind = classifyIdentifier(s);
  return {
    hasOuterSpace: s.length > 0 && s !== s.trim(),
    hasInnerSpace: (kind === 'email' || kind === 'username') && /\S\s+\S/.test(s.trim()),
    hasUppercase: (kind === 'email' || kind === 'username') && /[A-Z]/.test(s),
  };
}

// ── Domain typo suggestion (gmial.com → gmail.com) ──────────────────────────
const COMMON_DOMAINS = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br',
  'icloud.com', 'live.com', 'msn.com', 'me.com', 'aol.com',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com',
  'hotmail.com.br', 'outlook.com.br', 'live.com.br',
  'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com',
  'chatyy.com.br', 'onemundo.com.br',
];

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  // Optimal-string-alignment distance (Damerau): an adjacent transposition
  // (gmial → gmail) costs 1, like a single typo. Domains are short → full
  // matrix is fine.
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Returns the corrected full e-mail or null. Only SUGGESTS (the UI shows a
// "Você quis dizer …?" chip); never rewrites what the user typed.
export function suggestEmailFix(raw) {
  const v = String(raw || '').trim().toLowerCase();
  const at = v.lastIndexOf('@');
  if (at < 1) return null;
  const local = v.slice(0, at);
  let domain = v.slice(at + 1);
  if (!domain || domain.length < 4 || !domain.includes('.')) return null;
  // Cheap TLD slips first: .con/.cmo/.comm/.co (for gmail/hotmail…) → .com
  domain = domain.replace(/\.(con|cmo|ocm|vom|xom|comm|om)$/, '.com').replace(/\.com\.(bt|be|rb)$/, '.com.br');
  if (COMMON_DOMAINS.includes(domain)) {
    const fixed = `${local}@${domain}`;
    return fixed !== v ? fixed : null;
  }
  let best = null; let bestD = Infinity;
  for (const d of COMMON_DOMAINS) {
    const dist = levenshtein(domain, d);
    if (dist < bestD) { bestD = dist; best = d; }
  }
  // Conservative on purpose (a wrong "did you mean" is worse than none):
  // 1 edit, or 2 for long domains, AND the same first letter — real typos keep
  // it (gmial/gamil/hotmial/outlok) while corporate domains rarely do
  // (acme.com ≠ me.com, uol.com ≠ aol.com).
  const max = domain.length >= 10 ? 2 : 1;
  if (best && bestD > 0 && bestD <= max && best[0] === domain[0]) return `${local}@${best}`;
  return null;
}

// ── Phone helpers ───────────────────────────────────────────────────────────
export function findCountryByDial(dial) {
  return COUNTRIES.find(c => c.dial === dial) || null;
}

// "+5511999998888" → { country, national }. Longest dial prefix wins so
// "+351…" is Portugal, not "+35…". Returns null when nothing matches.
export function splitInternational(raw) {
  const digits = asciiDigits(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  let best = null;
  for (const c of COUNTRIES) {
    const d = c.dial.replace(/\D/g, '');
    if (digits.startsWith(d) && (!best || d.length > best.dial.replace(/\D/g, '').length)) best = c;
  }
  if (!best) return null;
  return { country: best, national: digits.slice(best.dial.replace(/\D/g, '').length) };
}

// Device-locale default (pt-BR → BR, en-US → US, es-MX → MX). Falls back to BR.
export function detectDefaultCountry() {
  let region = '';
  try {
    // eslint-disable-next-line global-require
    const L = require('expo-localization');
    region = (L.getLocales?.()[0]?.regionCode) || L.region || '';
  } catch {}
  if (!region && Platform.OS === 'web') {
    try { region = String((typeof navigator !== 'undefined' && navigator.language) || '').split('-')[1] || ''; } catch {}
  }
  if (!region) {
    try { region = String(Intl.DateTimeFormat().resolvedOptions().locale || '').split('-')[1] || ''; } catch {}
  }
  const code = String(region || '').toUpperCase();
  return COUNTRIES.find(c => c.code === code) || COUNTRIES[0];
}

// ── Password heuristics (only surfaced AFTER a failed attempt) ──────────────
export function passwordHints(pw) {
  const s = String(pw || '');
  const letters = s.replace(/[^A-Za-z]/g, '');
  return {
    allCaps: letters.length >= 3 && letters === letters.toUpperCase(),
    outerSpace: s.length > 0 && s !== s.trim(),
  };
}

// ── Last identifier (prefill, Instagram-style) ──────────────────────────────
const LAST_ID_KEY = '@chatyy_login_last_id';
function _store() {
  // eslint-disable-next-line global-require
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}
export async function loadLastIdentifier() {
  try { const v = await _store()?.getItem(LAST_ID_KEY); return typeof v === 'string' ? v : ''; } catch { return ''; }
}
export function saveLastIdentifier(id) {
  try { if (id) _store()?.setItem(LAST_ID_KEY, String(id)).catch(() => {}); } catch {}
}
export function forgetLastIdentifier() {
  try { _store()?.removeItem(LAST_ID_KEY).catch(() => {}); } catch {}
}
