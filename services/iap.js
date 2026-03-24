/**
 * Chatyy IAP - Apple In-App Subscriptions
 * Uses expo-in-app-purchases for iOS
 * Android/Web: falls back to Stripe web payment
 */
import { Platform, Linking } from 'react-native';
import { iapRestorePurchases as apiRestore, iapSubscriptionInfo as apiSubInfo } from './api';

// Product IDs - must match App Store Connect
export const PRODUCT_IDS = [
  'com.chatyy.one.monthly',     // Chatyy One - Monthly
  'com.chatyy.one.yearly',      // Chatyy One - Yearly
  'com.chatyy.family.monthly',  // Chatyy Family - Monthly
  'com.chatyy.family.yearly',   // Chatyy Family - Yearly
];

let _iapModule = null;
let _products = [];
let _available = false;
let _purchaseListener = null;

export async function initIAP() {
  if (Platform.OS !== 'ios') return false;
  try {
    _iapModule = require('expo-in-app-purchases');
    await _iapModule.connectAsync();
    _available = true;

    // Set purchase listener
    _iapModule.setPurchaseListener(({ responseCode, results }) => {
      if (responseCode === _iapModule.IAPResponseCode.OK && results) {
        results.forEach(async (purchase) => {
          if (!purchase.acknowledged) {
            // Send receipt to our server for validation
            try {
              await apiRestore(purchase.transactionReceipt);
              _iapModule.finishTransactionAsync(purchase, false);
            } catch (e) {
              console.warn('[IAP] Server validation failed:', e.message);
            }
          }
        });
      }
      if (_purchaseListener) _purchaseListener(responseCode, results);
    });

    // Load products
    const { responseCode, results } = await _iapModule.getProductsAsync(PRODUCT_IDS);
    if (responseCode === _iapModule.IAPResponseCode.OK && results) {
      _products = results;
    }
    return true;
  } catch (e) {
    console.warn('[IAP] Init failed:', e.message);
    _available = false;
    return false;
  }
}

export async function purchaseSubscription(productId) {
  if (Platform.OS !== 'ios' || !_available || !_iapModule) {
    // Android/Web: redirect to Stripe
    Linking.openURL('https://chatyy.com.br/#/plans');
    return { success: false, message: 'Redirecionando para pagamento web' };
  }

  return new Promise((resolve) => {
    _purchaseListener = (responseCode, results) => {
      _purchaseListener = null;
      if (responseCode === _iapModule.IAPResponseCode.OK) {
        resolve({ success: true, purchase: results?.[0] });
      } else if (responseCode === _iapModule.IAPResponseCode.USER_CANCELED) {
        resolve({ success: false, message: 'Compra cancelada' });
      } else {
        resolve({ success: false, message: 'Erro na compra (code: ' + responseCode + ')' });
      }
    };

    _iapModule.purchaseItemAsync(productId).catch((e) => {
      _purchaseListener = null;
      resolve({ success: false, message: e.message || 'Erro na compra' });
    });
  });
}

export async function restorePurchases() {
  if (Platform.OS !== 'ios' || !_available || !_iapModule) {
    return { success: false, message: 'Disponivel apenas no iOS' };
  }
  try {
    const { responseCode, results } = await _iapModule.getPurchaseHistoryAsync();
    if (responseCode === _iapModule.IAPResponseCode.OK && results?.length > 0) {
      // Send latest receipt to server
      const latest = results[results.length - 1];
      const serverRes = await apiRestore(latest.transactionReceipt);
      return serverRes;
    }
    return { success: false, message: 'Nenhuma compra encontrada' };
  } catch (e) {
    return { success: false, message: e.message || 'Erro ao restaurar' };
  }
}

export function getProductId(plan, period) {
  return `com.chatyy.${plan}.${period}`;
}

export function getLocalizedPrice(productId) {
  const product = _products.find(p => p.productId === productId);
  return product?.price || '';
}

export function getProducts() { return _products; }
export function isAvailable() { return _available; }

export function disconnectIAP() {
  if (_iapModule && _available) {
    try { _iapModule.disconnectAsync(); } catch {}
  }
  _available = false;
  _products = [];
}
