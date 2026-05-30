// context/CurrencyContext.js
// User's preferred display currency, persisted across launches.
//
// All prices are stored as BRL centavos canonically. This context decides
// what currency the UI renders them in (wallet balance, plan prices,
// invoice history, etc.). Conversion is display-only — IAP receipts,
// payouts, ledger entries all stay BRL.
//
// First launch: auto-detect from device locale via detectCurrency().
// Once the user manually picks, we persist `app_currency_manual` and
// stop auto-detecting.

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  detectCurrency,
  getRates,
  formatMoney as _formatMoney,
  setActiveCurrency,
  SUPPORTED_CURRENCIES,
  CURRENCY_SYMBOLS,
} from '../services/currencyService';

const CurrencyContext = createContext(null);

const STORAGE_KEY = 'app_currency_manual';

async function _readPersistedCurrency() {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(STORAGE_KEY);
      return null;
    }
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function _persistCurrency(code) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, code);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, code);
    }
  } catch {}
}

export function CurrencyProvider({ children }) {
  // Start with BRL synchronously so renders during first-paint don't
  // flicker between "no currency" and "USD". useEffect upgrades to the
  // manually-chosen / auto-detected value on mount.
  const [currency, setCurrencyState] = useState('BRL');
  const [autoDetected, setAutoDetected] = useState(true);

  // Mirror the chosen currency into the service singleton so that
  // module-level formatters (e.g. marketplace.js formatBRL) convert to
  // the same currency without needing a hook.
  useEffect(() => {
    setActiveCurrency(currency);
  }, [currency]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const manual = await _readPersistedCurrency();
      if (cancelled) return;
      if (manual && SUPPORTED_CURRENCIES.includes(manual)) {
        setCurrencyState(manual);
        setAutoDetected(false);
      } else {
        const detected = detectCurrency();
        setCurrencyState(SUPPORTED_CURRENCIES.includes(detected) ? detected : 'BRL');
        setAutoDetected(true);
      }
      // Warm the FX cache so the very first formatMoney() call in render
      // doesn't have to fall back to static rates.
      getRates().catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);

  const setCurrency = useCallback((code) => {
    if (!SUPPORTED_CURRENCIES.includes(code)) return;
    setCurrencyState(code);
    setAutoDetected(false);
    _persistCurrency(code);
  }, []);

  // Reset to auto-detect — wipes the manual override.
  const resetCurrency = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
    const detected = detectCurrency();
    setCurrencyState(SUPPORTED_CURRENCIES.includes(detected) ? detected : 'BRL');
    setAutoDetected(true);
  }, []);

  const value = useMemo(() => ({
    currency,
    setCurrency,
    resetCurrency,
    autoDetected,
    supported: SUPPORTED_CURRENCIES,
    symbols: CURRENCY_SYMBOLS,
  }), [currency, setCurrency, resetCurrency, autoDetected]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

// Hook: useCurrency() -> { currency, setCurrency, format, ... }
// `format(cents, localeOverride?)` is a convenience that bakes in the
// user's current currency choice, so call sites just do
// `format(item.price_cents)`.
export function useCurrency(localeForFormat) {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Defensive — if a screen is mounted outside the provider (e.g. an
    // error boundary fallback), don't crash; just return BRL formatter.
    return {
      currency: 'BRL',
      setCurrency: () => {},
      resetCurrency: () => {},
      autoDetected: true,
      supported: SUPPORTED_CURRENCIES,
      symbols: CURRENCY_SYMBOLS,
      format: (cents) => _formatMoney(cents, 'BRL', localeForFormat || 'pt-BR'),
    };
  }
  const format = useCallback(
    (cents, localeOverride) => _formatMoney(cents, ctx.currency, localeOverride || localeForFormat || 'pt-BR'),
    [ctx.currency, localeForFormat]
  );
  return { ...ctx, format };
}
