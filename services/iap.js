/**
 * Chatyy IAP - In-App Subscriptions
 * iOS/Android/Web: uses Stripe web payment (most reliable)
 * expo-in-app-purchases removed (breaks SDK 55 builds)
 */
import { Platform, Linking } from 'react-native';
import { iapRestorePurchases as apiRestore } from './api';

// Product IDs - must match App Store Connect
export const PRODUCT_IDS = [
  'com.chatyy.one.monthly',     // Chatyy One - Monthly
  'com.chatyy.one.yearly',      // Chatyy One - Yearly
  'com.chatyy.family.monthly',  // Chatyy Family - Monthly
  'com.chatyy.family.yearly',   // Chatyy Family - Yearly
];

let _available = false;

export async function initIAP() {
  _available = true;
  return true;
}

export async function purchaseSubscription(productId) {
  Linking.openURL('https://chatyy.com.br/#/plans');
  return { success: false, message: 'Redirecionando para pagamento' };
}

export async function restorePurchases() {
  try {
    return await apiRestore('web');
  } catch (e) {
    return { success: false, message: e.message || 'Erro ao restaurar' };
  }
}

export function getProductId(plan, period) {
  return `com.chatyy.${plan}.${period}`;
}

export function getLocalizedPrice() { return ''; }
export function getProducts() { return []; }
export function isAvailable() { return _available; }
export function disconnectIAP() { _available = false; }
