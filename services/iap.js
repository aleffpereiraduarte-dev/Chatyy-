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

export const PRODUCT_IDS = [
  'com.onemundo.mail.one_monthly',
  'com.onemundo.mail.one_annual',
  'com.onemundo.mail.family_monthly',
  'com.onemundo.mail.family_annual',
  'com.onemundo.mail.storage_500',
  'com.onemundo.mail.storage_1000',
  'com.onemundo.mail.storage_2000',
];

let _available = false;
let _products = [];
let _purchaseSub = null;
let _errorSub = null;
let _initPromise = null; // guard against concurrent initIAP() calls
let _lastDiagnostic = null; // last reason fetchProducts/init failed, for UI

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
    try {
      const products = await mod.fetchProducts({ skus: PRODUCT_IDS, type: 'subs' });
      _products = Array.isArray(products) ? products : [];
      if (_products.length === 0) {
        // initConnection succeeded but StoreKit returned zero products — this
        // is the single most common failure mode. The cause is almost always
        // one of: no sandbox Apple ID signed in on the device, products not
        // yet propagated (can take up to 24h after ASC changes), or bundleID
        // mismatch between binary and ASC config.
        _lastDiagnostic = 'no_products_returned';
      } else {
        _lastDiagnostic = null;
      }
    } catch (fetchErr) {
      if (__DEV__) console.warn('[IAP] fetchProducts failed:', fetchErr?.message);
      _products = [];
      _lastDiagnostic = 'fetch_failed:' + (fetchErr?.message || 'unknown');
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
  return `com.onemundo.mail.${plan}_${p}`;
}

export function getLocalizedPrice(productId) {
  const p = _products.find(x => x.id === productId || x.productId === productId);
  return p?.localizedPrice || p?.displayPrice || '';
}

/** Send the purchase to our backend for Apple-signed verification +
 *  plan activation. Finish the transaction afterwards (required or
 *  Apple will auto-refund after ~24h). */
async function _finalizePurchase(purchase) {
  try {
    // expo-iap purchase shape: { id, productId, transactionId,
    //   transactionReceipt, purchaseToken, originalTransactionIdentifierIOS, ... }
    const receipt = purchase.transactionReceipt || purchase.purchaseToken || '';
    const txId = purchase.transactionId || purchase.id || '';
    if (txId && purchase.productId) {
      await apiCall('iap_verify_receipt', {
        platform: Platform.OS,
        product_id: purchase.productId,
        receipt,
        transaction_id: txId,
      }, 'POST');
    }
  } catch (e) {
    if (__DEV__) console.warn('[IAP] verify_receipt failed:', e?.message);
  } finally {
    try {
      const mod = _getIAP();
      if (mod?.finishTransaction) {
        await mod.finishTransaction({ purchase, isConsumable: false });
      }
    } catch (e) {
      if (__DEV__) console.warn('[IAP] finishTransaction failed:', e?.message);
    }
  }
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
