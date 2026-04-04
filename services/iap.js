/**
 * Chatyy IAP - In-App Subscriptions
 * iOS/Android/Web: uses Stripe web payment (most reliable)
 * expo-in-app-purchases removed (breaks SDK 55 builds)
 */
import { Platform, Linking } from 'react-native';
import { iapRestorePurchases as apiRestore, getBaseUrl } from './api';

// Product IDs - must match App Store Connect exactly
export const PRODUCT_IDS = [
  'com.onemundo.mail.one_monthly',      // Chatyy One - Monthly
  'com.onemundo.mail.one_annual',       // Chatyy One - Annual
  'com.onemundo.mail.family_monthly',   // Chatyy Family - Monthly
  'com.onemundo.mail.family_annual',    // Chatyy Family - Annual
  'com.onemundo.mail.storage_500',      // Storage 500GB
  'com.onemundo.mail.storage_1000',     // Storage 1TB
  'com.onemundo.mail.storage_2000',     // Storage 2TB
];

let _available = false;

export async function initIAP() {
  _available = true;
  return true;
}

export async function purchaseSubscription(productId) {
  Linking.openURL(`${getBaseUrl()}/#/plans`);
  return { success: false, message: 'Redirecionando para pagamento' };
}

export async function restorePurchases() {
  try {
    return await apiRestore('web');
  } catch (e) {
    return { success: false, message: e.message || 'Erro ao restaurar' };
  }
}

export function getProductId(plan, period, storageGb) {
  // Storage-only plans
  if (storageGb) return `com.onemundo.mail.storage_${storageGb}`;
  // Subscription plans - map period names
  const periodMap = { monthly: 'monthly', yearly: 'annual', annual: 'annual' };
  const p = periodMap[period] || period;
  return `com.onemundo.mail.${plan}_${p}`;
}

export function getLocalizedPrice() { return ''; }
export function getProducts() { return []; }
export function isAvailable() { return _available; }
export function disconnectIAP() { _available = false; }
