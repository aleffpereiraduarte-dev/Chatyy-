// services/currencyService.js
// Live FX rate fetcher + Intl.NumberFormat-based money formatter.
//
// Backend: POST /api/chat.php { action: 'chat_currency_rates' } returns
// { base: 'BRL', rates: { USD: 0.20, EUR: 0.18, ... } } cached server-side
// for 24h. We cache the response in AsyncStorage (mobile) or localStorage
// (web) for another 24h so cold opens don't hammer the API.
//
// All app prices internally are BRL centavos (matches App Store SKUs +
// PostgreSQL `amount_cents` columns). Conversion is one-way for display
// only — IAP receipts, wallet balance, payouts all stay BRL-canonical.
//
// Fallback ladder, in order:
//   1. In-memory cache (this session)
//   2. Persisted cache (<24h old)
//   3. Network fetch
//   4. Persisted cache (any age, even stale)
//   5. Hard-coded STATIC_FALLBACK
//
// 2026-05-22 — issue #1355: bootstrap the front for chat_currency_rates.
// Backend endpoint may still be flaky (routing problem flagged in issue);
// the static fallback keeps the UI sane until the route is wired.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Approximate rates (BRL -> X). Refreshed manually on each release; the
// network fetch is what keeps these honest day-to-day. Numbers are the
// FX rate, not display precision — Intl.NumberFormat decides decimals.
const STATIC_FALLBACK = {
  USD: 0.20,
  EUR: 0.18,
  GBP: 0.16,
  BRL: 1,
  ARS: 200,
  MXN: 3.4,
  COP: 800,
  PEN: 0.75,
  CLP: 180,
};

export const SUPPORTED_CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'COP', 'PEN', 'CLP'];

// Visual symbol map — used by the picker UI. The actual rendered string
// comes from Intl.NumberFormat (which already inserts the correct symbol
// per locale), but we surface these in the settings list so the user
// recognises which option is which at a glance.
export const CURRENCY_SYMBOLS = {
  BRL: 'R$',
  USD: '$',
  EUR: '€',
  GBP: '£',
  ARS: '$',
  MXN: '$',
  COP: '$',
  PEN: 'S/',
  CLP: '$',
};

const STORAGE_KEY = 'currency_rates_cache_v1';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Module-level singleton cache. Reset by tests via _resetCache().
let _memCache = null;          // { base, rates, fetchedAt }
let _inflight = null;          // dedupe concurrent getRates() calls

async function _readPersisted() {
  try {
    let raw = null;
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') raw = localStorage.getItem(STORAGE_KEY);
    } else {
      raw = await AsyncStorage.getItem(STORAGE_KEY);
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.rates || typeof parsed.rates !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function _writePersisted(payload) {
  try {
    const raw = JSON.stringify(payload);
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, raw);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, raw);
    }
  } catch {}
}

async function _fetchFromBackend() {
  // Lazy import so this module doesn't drag api.js into early boot —
  // we don't want currency formatting to crash if api.js fails to load
  // on cold splash (e.g. when offline before login).
  let apiCall;
  try {
    const mod = require('./api');
    apiCall = mod.apiCall;
  } catch {
    return null;
  }
  if (typeof apiCall !== 'function') return null;
  try {
    const res = await apiCall('chat_currency_rates', {}, 'POST');
    if (!res || !res.rates || typeof res.rates !== 'object') return null;
    // Guarantee BRL=1 even if backend omits it — divides will explode
    // otherwise.
    const rates = { ...res.rates, BRL: 1 };
    return { base: res.base || 'BRL', rates, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

function _staticPayload() {
  return { base: 'BRL', rates: { ...STATIC_FALLBACK }, fetchedAt: 0 };
}

// Public: returns the FX payload. Uses memory cache, then persisted
// cache (<24h), then network, then stale persisted, then static.
export async function getRates() {
  if (_memCache && Date.now() - _memCache.fetchedAt < TTL_MS) return _memCache;

  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const persisted = await _readPersisted();
      if (persisted && Date.now() - (persisted.fetchedAt || 0) < TTL_MS) {
        _memCache = persisted;
        return persisted;
      }

      const fetched = await _fetchFromBackend();
      if (fetched) {
        _memCache = fetched;
        _writePersisted(fetched); // fire-and-forget
        return fetched;
      }

      // Backend dead — fall back to stale persisted if we have any.
      if (persisted) {
        _memCache = persisted;
        return persisted;
      }

      const stat = _staticPayload();
      _memCache = stat;
      return stat;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

// Synchronous variant — returns whatever's in memory (or static fallback
// if nothing's been fetched yet). Useful in render paths where awaiting
// would force re-renders. Pair with a one-shot getRates() in useEffect.
export function getRatesSync() {
  return _memCache || _staticPayload();
}

// Convert BRL centavos -> target currency and render with the user's
// locale. `locale` is the BCP47 tag we get from LanguageContext
// (pt-BR / en / es / etc.); Intl.NumberFormat handles the rest.
//
// Examples:
//   formatMoney(990, 'USD', 'en-US') -> "$2.00"
//   formatMoney(990, 'BRL', 'pt-BR') -> "R$ 9,90"
//   formatMoney(990, 'EUR', 'fr-FR') -> "1,78 €"
export function formatMoney(centavosBRL, targetCurrency = 'BRL', locale = 'pt-BR') {
  const cents = Number(centavosBRL) || 0;
  const brl = cents / 100;
  const cur = (targetCurrency || 'BRL').toUpperCase();
  const payload = getRatesSync();
  const rate = payload.rates[cur];
  // Unknown currency — render as BRL so the user at least sees something.
  const safeRate = typeof rate === 'number' && rate > 0 ? rate : (cur === 'BRL' ? 1 : null);
  if (safeRate === null) {
    return new Intl.NumberFormat(locale || 'pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(brl);
  }
  const converted = brl * safeRate;
  try {
    return new Intl.NumberFormat(locale || 'pt-BR', {
      style: 'currency',
      currency: cur,
    }).format(converted);
  } catch {
    // Hermes on Android historically shipped without full ICU. Fall back
    // to a manual format so we don't crash render.
    const sym = CURRENCY_SYMBOLS[cur] || '';
    return `${sym}${converted.toFixed(2)}`;
  }
}

// Auto-detect from device locale on first run. Returns one of
// SUPPORTED_CURRENCIES or 'BRL' as a final fallback.
export function detectCurrency() {
  try {
    // Intl.NumberFormat().resolvedOptions().locale gives us the user's
    // preferred locale even if we don't have an Intl.Locale polyfill.
    const opts = new Intl.NumberFormat().resolvedOptions();
    const loc = (opts.locale || '').toLowerCase();
    if (loc.startsWith('pt')) return 'BRL';
    if (loc.includes('-us') || loc === 'en') return 'USD';
    if (loc.includes('-gb')) return 'GBP';
    if (loc.includes('-ar') || loc === 'es-ar') return 'ARS';
    if (loc.includes('-mx')) return 'MXN';
    if (loc.includes('-co')) return 'COP';
    if (loc.includes('-pe')) return 'PEN';
    if (loc.includes('-cl')) return 'CLP';
    if (loc.startsWith('en')) return 'USD';
    if (loc.startsWith('es')) return 'USD'; // generic ES picks USD over a random LATAM peg
    if (loc.startsWith('fr') || loc.startsWith('de') || loc.startsWith('it')) return 'EUR';
    return 'BRL';
  } catch {
    return 'BRL';
  }
}

// Test/debug only.
export function _resetCache() {
  _memCache = null;
  _inflight = null;
}
