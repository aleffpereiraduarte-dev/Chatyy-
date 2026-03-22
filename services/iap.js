/**
 * Chatyy IAP - stub for now
 * expo-iap causes Android build failures
 * iOS users directed to web Stripe payment
 */
import { Platform, Linking } from 'react-native';

export const PRODUCT_IDS = [];
export async function initIAP() { return false; }
export async function purchaseSubscription() {
  if (Platform.OS === 'ios') Linking.openURL('https://chatyy.com.br/#/plans');
  return { success: false, message: 'Use web payment' };
}
export async function restorePurchases() { return { success: false, message: 'Not available' }; }
export function getProductId() { return ''; }
export function getLocalizedPrice() { return ''; }
export function getProducts() { return []; }
export function isAvailable() { return false; }
export function disconnectIAP() {}
