/**
 * Chatyy IAP — real StoreKit via expo-iap (OpenIAP).
 *
 * Uses the Expo Module arch (not NitroModules) so it autolinks cleanly
 * on our Mac 207 build flow. No extra peer deps.
 *
 * Flow:
 *   1. initConnection() on iOS startup
 *   2. fetchProducts({ skus, type:'subs' }) loads prices/metadata
 *   3. User taps upgrade → requestPurchase({ request: { ios: { sku } }})
 *   4. purchaseUpdatedListener fires with receipt → POST to
 *      /api/email.php?action=iap_verify_receipt → backend flips plan
 *   5. finishTransaction(purchase) acknowledges (required by Apple)
 *
 * Products:
 *   com.onemundo.mail.one_monthly   (R$14.99/mo, 30-day free trial)
 *   com.onemundo.mail.one_annual    (R$149.90/yr, 30-day free trial)
 *   com.onemundo.mail.family_monthly (R$29.99/mo)
 *   com.onemundo.mail.family_annual  (R$279.90/yr)
 *   com.onemundo.mail.storage_500/1000/2000
 */
import { Platform, Linking } from 'react-native';
import { iapRestorePurchases as apiRestore, getBaseUrl, apiCall } from './api';

// Lazy-load expo-iap: importing it at module scope crashed build 365 on
// cold-start because the native StoreKit observer was attaching before RN
// had a chance to mount an error boundary. We now resolve the module the
// first time a caller actually needs it (plans screen open / restore).
let IAP = null;
function _getIAP() {
  if (IAP) return IAP;
  if (Platform.OS === 'web') return null;
  try {
    IAP = require('expo-iap');
    return IAP;
  } catch (e) {
    if (__DEV__) console.warn('[IAP] require failed:', e?.message);
    IAP = null;
    return null;
  }
}

// 2026-04 redesigned ladder. New product IDs first; legacy IDs kept
// alive so users with active `one_*` / `family_*` subscriptions still
// see "current plan" hydrated correctly during the App Store Connect
// product migration.
export const PRODUCT_IDS = [
  // New: Plus / Pro
  'com.onemundo.mail.plus_monthly',
  'com.onemundo.mail.plus_annual',
  'com.onemundo.mail.pro_monthly',
  'com.onemundo.mail.pro_annual',
  // Legacy aliases
  'com.onemundo.mail.one_monthly',
  'com.onemundo.mail.one_annual',
  'com.onemundo.mail.family_monthly',
  'com.onemundo.mail.family_annual',
  // Storage add-ons
  'com.onemundo.mail.storage_500',
  'com.onemundo.mail.storage_1000',
  'com.onemundo.mail.storage_2000',
];

// 2026-05-18 — Consumable diamond top-up SKUs (BRL pricing, +bonus tiers).
// Must be registered manually in App Store Connect (Consumable type) +
// Google Play Console (Managed product / Consumable). Backend pack table
// in /var/www/mail/api/chat.php (case 'wallet_buy_diamonds') is the source
// of truth for diamond credit math; this list is just StoreKit metadata.
export const DIAMOND_PACK_SKUS = [
  'chatyy_diamond_100',
  'chatyy_diamond_500',
  'chatyy_diamond_1500',
  'chatyy_diamond_5000',
  'chatyy_diamond_15000',
];

// Catalog used by DiamondTopUpSheet to render the grid before the StoreKit
// fetchProducts() response lands. Keep in sync with the server catalog —
// the server still recomputes diamonds credited on receipt verification.
export const DIAMOND_PACKS = [
  { sku: 'chatyy_diamond_100',   diamonds: 100,   priceBrl: 4.99,   bonusPct: 0  },
  { sku: 'chatyy_diamond_500',   diamonds: 550,   priceBrl: 19.99,  bonusPct: 10 },
  { sku: 'chatyy_diamond_1500',  diamonds: 1700,  priceBrl: 49.99,  bonusPct: 13 },
  { sku: 'chatyy_diamond_5000',  diamonds: 6000,  priceBrl: 149.99, bonusPct: 20 },
  { sku: 'chatyy_diamond_15000', diamonds: 19500, priceBrl: 399.99, bonusPct: 30 },
];

let _available = false;
let _products = [];
let _diamondProducts = []; // type:'inapp' consumable diamond packs
let _purchaseSub = null;
let _errorSub = null;
let _initPromise = null; // guard against concurrent initIAP() calls
let _lastDiagnostic = null; // last reason fetchProducts/init failed, for UI
let _pendingTopupCallback = null; // resolved by listener after wallet credit

export async function initIAP() {
  if (Platform.OS !== 'ios') { _available = false; return false; }
  // Cache the init promise so parallel callers (mount + button tap + focus
  // effect) share the same initConnection rather than each opening its
  // own StoreKit observer — duplicate observers crashed build 365.
  if (_initPromise) return _initPromise;
  _initPromise = _doInitIAP().catch((e) => {
    _initPromise = null; // allow retry after a hard failure
    throw e;
  });
  return _initPromise;
}

async function _doInitIAP() {
  const mod = _getIAP();
  if (!mod) {
    _available = false;
    _lastDiagnostic = 'module_not_loaded';
    return false;
  }
  try {
    await mod.initConnection();
    // Retry up to 3 times with exponential backoff. Apple's StoreKit (esp.
    // during review) often returns 0 products on the first call right after
    // initConnection, then succeeds 1-3s later. Without retry, our reviewers
    // were seeing "Assinaturas indisponíveis" and rejecting builds.
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const products = await mod.fetchProducts({ skus: PRODUCT_IDS, type: 'subs' });
        _products = Array.isArray(products) ? products : [];
        if (_products.length > 0) { _lastDiagnostic = null; break; }
        _lastDiagnostic = 'no_products_returned';
      } catch (fetchErr) {
        if (__DEV__) console.warn(`[IAP] fetchProducts attempt ${attempt} failed:`, fetchErr?.message);
        _products = [];
        _lastDiagnostic = 'fetch_failed:' + (fetchErr?.message || 'unknown');
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 800 * attempt)); // 800ms, 1.6s
      }
    }

    // Diamond top-ups are consumables (type:'inapp'), not subscriptions —
    // StoreKit returns nothing for them when queried as 'subs'. Best-effort
    // fetch; failures are silent because the top-up sheet has a static
    // fallback (DIAMOND_PACKS) and the user just sees BRL labels in that
    // case instead of locale-correct StoreKit prices.
    try {
      const diamondProducts = await mod.fetchProducts({ skus: DIAMOND_PACK_SKUS, type: 'inapp' });
      if (Array.isArray(diamondProducts) && diamondProducts.length) {
        _diamondProducts = diamondProducts;
      }
    } catch (e) {
      if (__DEV__) console.warn('[IAP] diamond fetchProducts failed:', e?.message);
    }

    if (!_purchaseSub && mod.purchaseUpdatedListener) {
      _purchaseSub = mod.purchaseUpdatedListener(async (purchase) => {
        try { await _finalizePurchase(purchase); } catch (e) {
          if (__DEV__) console.warn('[IAP] finalize error:', e?.message);
        }
      });
    }
    if (!_errorSub && mod.purchaseErrorListener) {
      _errorSub = mod.purchaseErrorListener((err) => {
        if (__DEV__) console.warn('[IAP] purchase error:', err?.code, err?.message);
      });
    }
    _available = true;
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[IAP] init failed:', e?.message);
    _available = false;
    _lastDiagnostic = 'init_failed:' + (e?.message || 'unknown');
    return false;
  }
}

export function isAvailable() { return _available; }
export function getProducts() { return _products; }
export function getLastDiagnostic() { return _lastDiagnostic; }

export function getProductId(plan, period, storageGb) {
  if (storageGb) return `com.onemundo.mail.storage_${storageGb}`;
  const periodMap = { monthly: 'monthly', yearly: 'annual', annual: 'annual' };
  const p = periodMap[period] || period;
  // ASC only has the legacy product IDs registered today
  // (one_monthly/annual, family_monthly/annual). The new
  // plus_*/pro_* SKUs are not live yet, so we route the new tier
  // names BACK to the legacy SKUs to keep StoreKit happy. When
  // ASC gets the redesigned products (com.onemundo.mail.plus_*
  // and pro_*) we flip this mapping the other way.
  const planMap = { plus: 'one', pro: 'family' };
  const mapped = planMap[plan] || plan;
  return `com.onemundo.mail.${mapped}_${p}`;
}

export function getLocalizedPrice(productId) {
  const p = _products.find(x => x.id === productId || x.productId === productId);
  return p?.localizedPrice || p?.displayPrice || '';
}

/** Send the purchase to our backend for Apple-signed verification +
 *  plan activation. Finish the transaction afterwards (required or
 *  Apple will auto-refund after ~24h). */
async function _finalizePurchase(purchase) {
  let verified = false;
  let resultData = null;
  const isDiamond = typeof purchase?.productId === 'string'
    && purchase.productId.indexOf('chatyy_diamond_') === 0;
  try {
    // expo-iap purchase shape: { id, productId, transactionId,
    //   transactionReceipt, purchaseToken, originalTransactionIdentifierIOS, ... }
    const receipt = purchase.transactionReceipt || purchase.purchaseToken || '';
    const txId = purchase.transactionId || purchase.id || '';
    if (txId && purchase.productId) {
      const action = isDiamond ? 'wallet_topup_verify' : 'iap_verify_receipt';
      const r = await apiCall(action, {
        platform: Platform.OS,
        sku: purchase.productId,             // wallet_topup_verify reads this
        product_id: purchase.productId,      // iap_verify_receipt reads this
        receipt,
        transaction_id: txId,
      }, 'POST');
      verified = !!r?.success;
      resultData = r?.data || null;
    }
  } catch (e) {
    if (__DEV__) console.warn('[IAP] verify failed:', e?.message);
  }
  // Só finaliza a transação se o backend confirmou. Senão deixa pendente
  // pra retry no próximo listener/restore — finishTransaction sem verify
  // bem-sucedido fazia o usuário pagar e ficar sem upgrade.
  if (!verified) {
    if (isDiamond && _pendingTopupCallback) {
      try { _pendingTopupCallback({ success: false, message: 'verify_failed' }); } catch {}
      _pendingTopupCallback = null;
    }
    return;
  }
  try {
    const mod = _getIAP();
    if (mod?.finishTransaction) {
      // Diamond packs are consumables — Apple requires isConsumable:true so
      // the same SKU can be purchased again. Subscriptions stay non-consumable.
      await mod.finishTransaction({ purchase, isConsumable: isDiamond });
    }
  } catch (e) {
    if (__DEV__) console.warn('[IAP] finishTransaction failed:', e?.message);
  }
  if (isDiamond && _pendingTopupCallback) {
    try {
      _pendingTopupCallback({
        success: true,
        sku: purchase.productId,
        diamondBalance: Number(resultData?.diamond_balance) || 0,
        diamondsAdded: Number(resultData?.diamonds_added) || 0,
      });
    } catch {}
    _pendingTopupCallback = null;
  }
}

/** Start a consumable diamond top-up purchase via StoreKit sheet.
 *  Resolves once the purchase listener fires (success/fail). Web/Android-
 *  unsupported callers get web_fallback so the UI can route to /plans.
 *
 *  Returns: { success, sku?, diamondBalance?, diamondsAdded?, message? }
 */
export async function purchaseDiamonds(productId) {
  const mod = _getIAP();
  if (Platform.OS === 'web' || !mod) {
    try { Linking.openURL(`${getBaseUrl()}/#/plans`); } catch {}
    return { success: false, message: 'web_fallback' };
  }
  if (!_available) {
    try { await initIAP(); } catch {}
    if (!_available) return { success: false, message: 'iap_unavailable' };
  }
  // [#1188-followup, 2026-05-19] Guard against "SKU not found" — happens
  // when the StoreKit catalog doesn't have this product registered (the
  // chatyy_diamond_* IDs were never created in App Store Connect for some
  // builds). Without this check, requestPurchase throws raw "SKU not found"
  // and the user sees the iOS modal-over-modal error stack. With it, we
  // surface a friendly message and route to web checkout when available.
  const hasInCatalog = _diamondProducts.some(
    p => (p?.id || p?.productId) === productId
  );
  if (!hasInCatalog) {
    return {
      success: false,
      message: 'sku_not_in_catalog',
      sku: productId,
    };
  }
  // Wire a one-shot callback that the purchase listener resolves once the
  // backend wallet credit lands. Timeout after 90s — Apple sometimes spins
  // on the success sheet without firing the JS listener.
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  _pendingTopupCallback = (payload) => resolve(payload);
  const timer = setTimeout(() => {
    if (_pendingTopupCallback) {
      _pendingTopupCallback = null;
      resolve({ success: false, message: 'timeout' });
    }
  }, 90000);
  try {
    await mod.requestPurchase({
      request: {
        ios: { sku: productId },
        android: { skus: [productId] },
      },
      type: 'inapp', // consumable, not subs
    });
  } catch (e) {
    clearTimeout(timer);
    _pendingTopupCallback = null;
    const code = e?.code || '';
    if (code === 'E_USER_CANCELLED' || code === 'USER_CANCELLED') {
      return { success: false, message: 'cancelled' };
    }
    return { success: false, message: e?.message || 'purchase_failed' };
  }
  const result = await done;
  clearTimeout(timer);
  return result;
}

export function getDiamondProducts() { return _diamondProducts; }
export function getDiamondLocalizedPrice(productId) {
  const p = _diamondProducts.find(x => x.id === productId || x.productId === productId);
  return p?.localizedPrice || p?.displayPrice || '';
}
/** True iff this SKU was returned by StoreKit fetchProducts. UI uses this
 *  to grey out / hide diamond packs that aren't registered in App Store
 *  Connect, instead of showing a raw "SKU not found" purchase error. */
export function isDiamondSkuAvailable(productId) {
  if (Platform.OS !== 'ios') return true; // Android/web don't hit StoreKit
  if (!_diamondProducts.length) return false;
  return _diamondProducts.some(p => (p?.id || p?.productId) === productId);
}

/** Start a subscription purchase via StoreKit sheet. */
export async function purchaseSubscription(productId) {
  const mod = _getIAP();
  if (Platform.OS !== 'ios' || !mod || !_available) {
    try { Linking.openURL(`${getBaseUrl()}/#/plans`); } catch {}
    return { success: false, message: 'web_fallback' };
  }
  try {
    await mod.requestPurchase({
      request: {
        ios: { sku: productId },
        android: { skus: [productId] },
      },
      type: 'subs',
    });
    return { success: true };
  } catch (e) {
    const code = e?.code || '';
    if (code === 'E_USER_CANCELLED' || code === 'USER_CANCELLED') {
      const err = new Error('CANCELLED'); err.code = 'CANCELLED'; throw err;
    }
    throw e;
  }
}

/** Restore on iOS via StoreKit; Android/web via our server-side lookup. */
export async function restorePurchases() {
  const mod = _getIAP();
  if (Platform.OS === 'ios' && mod && _available) {
    try {
      const purchases = await mod.getAvailablePurchases();
      let restored = 0;
      for (const p of purchases || []) {
        try { await _finalizePurchase(p); restored++; } catch {}
      }
      return { success: restored > 0, count: restored };
    } catch (e) {
      return { success: false, message: e?.message || 'restore_failed' };
    }
  }
  try { return await apiRestore('web'); } catch (e) {
    return { success: false, message: e?.message || 'Erro ao restaurar' };
  }
}

export function disconnectIAP() {
  try { _purchaseSub?.remove?.(); } catch {}
  try { _errorSub?.remove?.(); } catch {}
  try { IAP?.endConnection?.(); } catch {}
  _purchaseSub = null;
  _errorSub = null;
  _available = false;
}
