/**
 * Chatyy IAP — real StoreKit + Google Play Billing via expo-iap (OpenIAP).
 *
 * Uses the Expo Module arch (not NitroModules) so it autolinks cleanly
 * on our Mac 207 build flow. No extra peer deps. expo-iap 4.x ships
 * GooglePlayBillingClient v6+ on Android — same JS surface as StoreKit
 * (initConnection / fetchProducts / requestPurchase / finishTransaction).
 *
 * Flow:
 *   1. initConnection() on iOS+Android startup
 *   2. fetchProducts({ skus, type:'subs'|'inapp' }) loads prices/metadata
 *   3. User taps upgrade → requestPurchase({ request: { ios|android } })
 *   4. purchaseUpdatedListener fires with receipt/purchaseToken → POST to
 *      backend (wallet_topup_verify or iap_verify_receipt) for verification
 *   5. finishTransaction(purchase) acknowledges (required by both stores —
 *      Google auto-refunds within 3 days if not acknowledged)
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
//
// WAVE 75 (2026-05-21) — App Store Connect actually registered these as
// `chatyy_diamonds_*` (plural). We keep the legacy `chatyy_diamond_*` IDs
// in DIAMOND_PACKS for backward compatibility on existing builds, but
// the production SKU list below is what gets sent to fetchProducts().
export const DIAMOND_PACK_SKUS = [
  // Production SKUs (ASC reg'd 2026-05-18, MISSING_METADATA pending screenshot)
  'chatyy_diamonds_100',
  'chatyy_diamonds_550',
  'chatyy_diamonds_1700',
  'chatyy_diamonds_6000',
  'chatyy_diamonds_19500',
  // Google Play SKUs (chatyy_topup_*) — created via /tmp/gplay_create_v2.py
  // when Payments profile unblocks. Same diamond credit math, separate IDs.
  'chatyy_topup_5',
  'chatyy_topup_20',
  'chatyy_topup_50',
  'chatyy_topup_150',
  'chatyy_topup_400',
];

// WAVE 75 (2026-05-21) — Storage subscription SKUs.
// iOS uses com.onemundo.mail.storage_* (ASC bundle-prefixed pattern, mirrors
// the existing storage_500/1000/2000 monthlies that are already approved).
// Android uses chatyy_storage_* + basePlanId 'monthly'/'annual' from
// Play Console (created via gplay_create_v2.py).
export const STORAGE_SUB_SKUS = [
  // iOS
  'com.onemundo.mail.storage_100',
  'com.onemundo.mail.storage_100_annual',
  'com.onemundo.mail.storage_500',
  'com.onemundo.mail.storage_500_annual',
  'com.onemundo.mail.storage_1000',
  'com.onemundo.mail.storage_1000_annual',
  'com.onemundo.mail.storage_5000',
  'com.onemundo.mail.storage_5000_annual',
  // Android (Play Console base-plan format collapses period into the SKU)
  'chatyy_storage_100',
  'chatyy_storage_500',
  'chatyy_storage_1tb',
  'chatyy_storage_5tb',
];

// Static fallback catalog for rendering the StorageShopSheet before
// fetchProducts() lands. Keep in sync with /var/www/mail/api/chat.php
// chat_storage_tiers response — server is the source of truth.
export const STORAGE_TIERS = [
  { id: '100gb', gb: 100,  priceMonthly: 4.99,  priceAnnual: 49.99,
    skuMonthlyApple:  'com.onemundo.mail.storage_100',
    skuAnnualApple:   'com.onemundo.mail.storage_100_annual',
    skuMonthlyGoogle: 'chatyy_storage_100',  basePlanMonthlyGoogle: 'monthly',
    skuAnnualGoogle:  'chatyy_storage_100',  basePlanAnnualGoogle:  'annual' },
  { id: '500gb', gb: 500,  priceMonthly: 14.99, priceAnnual: 149.99,
    skuMonthlyApple:  'com.onemundo.mail.storage_500',
    skuAnnualApple:   'com.onemundo.mail.storage_500_annual',
    skuMonthlyGoogle: 'chatyy_storage_500',  basePlanMonthlyGoogle: 'monthly',
    skuAnnualGoogle:  'chatyy_storage_500',  basePlanAnnualGoogle:  'annual' },
  { id: '1tb',   gb: 1024, priceMonthly: 24.99, priceAnnual: 249.99,
    skuMonthlyApple:  'com.onemundo.mail.storage_1000',
    skuAnnualApple:   'com.onemundo.mail.storage_1000_annual',
    skuMonthlyGoogle: 'chatyy_storage_1tb',  basePlanMonthlyGoogle: 'monthly',
    skuAnnualGoogle:  'chatyy_storage_1tb',  basePlanAnnualGoogle:  'annual' },
  { id: '5tb',   gb: 5120, priceMonthly: 89.99, priceAnnual: 899.99,
    skuMonthlyApple:  'com.onemundo.mail.storage_5000',
    skuAnnualApple:   'com.onemundo.mail.storage_5000_annual',
    skuMonthlyGoogle: 'chatyy_storage_5tb',  basePlanMonthlyGoogle: 'monthly',
    skuAnnualGoogle:  'chatyy_storage_5tb',  basePlanAnnualGoogle:  'annual' },
];

export const STORAGE_FREE_GB = 50;

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
let _storageProducts = []; // type:'subs' storage tier subscriptions (WAVE 75)
let _pendingStorageCallback = null; // resolved by purchase listener for storage flows
let _purchaseSub = null;
let _errorSub = null;
let _initPromise = null; // guard against concurrent initIAP() calls
let _lastDiagnostic = null; // last reason fetchProducts/init failed, for UI
let _pendingTopupCallback = null; // resolved by listener after wallet credit

export async function initIAP() {
  // 2026-05-19 — Android-side wired up. expo-iap 4.x exposes the same
  // initConnection/fetchProducts/requestPurchase JS surface for both
  // StoreKit and Google Play Billing, so we no longer early-return on
  // Android. Web still bails (no native module).
  if (Platform.OS === 'web') { _available = false; return false; }
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
    // Subscriptions are iOS-only today (Play Console doesn't have them
    // registered). On Android we skip subs entirely and only fetch the
    // consumable diamond catalog below — fetching unknown SKUs throws and
    // would corrupt _lastDiagnostic.
    if (Platform.OS === 'ios') {
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
    } else {
      _products = [];
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

    // WAVE 75 — storage subscriptions. Same fetchProducts surface, type 'subs'.
    // Failure is silent: StorageShopSheet has a static STORAGE_TIERS fallback
    // and the user sees BRL labels from the server-side catalog.
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      try {
        const storageProducts = await mod.fetchProducts({ skus: STORAGE_SUB_SKUS, type: 'subs' });
        if (Array.isArray(storageProducts) && storageProducts.length) {
          _storageProducts = storageProducts;
        }
      } catch (e) {
        if (__DEV__) console.warn('[IAP] storage fetchProducts failed:', e?.message);
      }
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
    // expo-iap purchase shape varies by store:
    //   iOS:     { id, productId, transactionId, transactionReceipt,
    //              originalTransactionIdentifierIOS, ... }
    //   Android: { id, productId, purchaseToken, transactionId(==orderId),
    //              packageNameAndroid, purchaseStateAndroid,
    //              isAcknowledgedAndroid, dataAndroid, signatureAndroid }
    // Google Play's idempotent identifier is purchaseToken (one per
    // purchase, opaque). orderId is the user-visible "GPA.xxx" id.
    const isAndroid = Platform.OS === 'android';
    const receipt = purchase.transactionReceipt || purchase.purchaseToken || '';
    const purchaseToken = purchase.purchaseToken || '';
    const orderId = isAndroid
      ? (purchase.transactionId || purchase.orderId || '')
      : '';
    // Idempotency key: on Android use purchaseToken (guaranteed unique
    // per purchase; orderId is null for promos/free products). On iOS we
    // continue using transactionId (StoreKit invariant).
    const txId = isAndroid
      ? (purchaseToken || purchase.transactionId || purchase.id || '')
      : (purchase.transactionId || purchase.id || '');
    if (txId && purchase.productId) {
      const action = isDiamond ? 'wallet_topup_verify' : 'iap_verify_receipt';
      const r = await apiCall(action, {
        platform: Platform.OS,
        sku: purchase.productId,             // wallet_topup_verify reads this
        product_id: purchase.productId,      // iap_verify_receipt reads this
        receipt,
        transaction_id: txId,
        // Android-specific — backend uses these to call
        // androidpublisher.purchases.products.get for verification +
        // .acknowledge to consume. Ignored on iOS.
        purchase_token: purchaseToken,
        order_id: orderId,
        package_name: isAndroid ? (purchase.packageNameAndroid || 'com.onemundo.mail') : '',
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
  // when the catalog doesn't have this product registered (the
  // chatyy_diamond_* IDs were never created in App Store Connect / Play
  // Console for some builds). Without this check, requestPurchase throws
  // raw "SKU not found" and the user sees the modal-over-modal error
  // stack. With it, we surface a friendly message and route to web
  // checkout when available. Note: Google Play returns products via the
  // SAME fetchProducts({type:'inapp'}) call as StoreKit, so the same
  // _diamondProducts cache covers both stores.
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
/** True iff this SKU was returned by fetchProducts (StoreKit on iOS,
 *  Google Play Billing on Android). UI uses this to grey out / hide
 *  diamond packs that aren't registered in ASC / Play Console, instead
 *  of showing a raw "SKU not found" purchase error. Web has no IAP, so
 *  we always allow it through (UI deep-links to /plans web checkout). */
export function isDiamondSkuAvailable(productId) {
  if (Platform.OS === 'web') return true; // web never hits a billing client
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

/** Restore on iOS+Android via the billing client; web via server lookup.
 *
 *  ANDROID RECOVERY: On cold-start we also call this to flush any
 *  unacknowledged purchases — Google Play auto-refunds the user if a
 *  purchase isn't acknowledged within 3 days, so we MUST replay any
 *  purchase the user closed the app on (network drop after Play sheet
 *  closed but before our listener fired). _finalizePurchase is
 *  idempotent via transaction_id, so re-running it is safe. */
export async function restorePurchases() {
  const mod = _getIAP();
  if ((Platform.OS === 'ios' || Platform.OS === 'android') && mod && _available) {
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

/** Android-only utility: list purchases that the Play library knows
 *  about but haven't been acknowledged/consumed yet. Should be called on
 *  app start to recover from a crash mid-flow. _finalizePurchase handles
 *  both verify (backend) + finishTransaction (acknowledge), so a single
 *  pass through this list is enough.
 *
 *  No-op on iOS (StoreKit replays unfinished tx via its own queue when
 *  initConnection runs).
 */
export async function flushPendingPurchases() {
  if (Platform.OS !== 'android') return { success: true, count: 0 };
  const mod = _getIAP();
  if (!mod || !_available) return { success: false, message: 'iap_unavailable' };
  try {
    const purchases = await mod.getAvailablePurchases();
    let count = 0;
    for (const p of purchases || []) {
      // Skip already-acknowledged (Google's billing v6 sets this)
      if (p?.isAcknowledgedAndroid) continue;
      try { await _finalizePurchase(p); count++; } catch {}
    }
    return { success: true, count };
  } catch (e) {
    return { success: false, message: e?.message || 'flush_failed' };
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
