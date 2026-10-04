// stripeCheckout — pagamento com cartao via Stripe Checkout HOSPEDADO.
//
// O cartao e digitado SOMENTE na pagina segura do Stripe (aberta num in-app
// browser). O app nunca ve o numero do cartao (PCI fora de escopo) e nao usa
// SDK nativo => 100% JS, OTA-safe.
//
// POLITICA DE PLATAFORMA: Apple exige IAP para bens digitais no iOS, entao o
// fluxo Stripe so e oferecido quando Platform.OS !== 'ios' (Android + web).
// Use isStripeCardAvailable() para decidir se mostra o botao.
//
// O webhook do backend confirma a assinatura; ao fechar o browser o app apenas
// re-busca o plano (planInfo) para refletir o novo estado.
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { apiCall, planInfo } from './api';
import { STRIPE_ENABLED, STRIPE_STORAGE_CHECKOUT } from '../constants/featureFlags';

export function isStripeCardAvailable() {
  return STRIPE_ENABLED && Platform.OS !== 'ios';
}

export function isStripeStorageCheckoutAvailable() {
  return isStripeCardAvailable() && STRIPE_STORAGE_CHECKOUT === true;
}

async function _openAndRefresh(url) {
  let result = null;
  try {
    result = await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle?.FULL_SCREEN,
      toolbarColor: '#0b0b0f',
      showTitle: true,
    });
  } catch (e) {
    return { success: false, message: 'browser_failed' };
  }
  // Browser fechado (sucesso OU cancelamento): o webhook e a fonte da verdade,
  // so re-buscamos o plano.
  let plan = null;
  try { plan = await planInfo(); } catch {}
  return { success: true, opened: true, browserResult: result?.type || null, plan };
}

// tierId: '100gb' | '500gb' | '1tb' | '2tb' | '5tb'; period: 'monthly' | 'annual'.
// Envia kind:'storage' (NAO envia `plan`): o backend atual (stripe_checkout)
// so aceita plan one/family e responde 400 'Invalid plan' para storage ate
// ser ajustado — falha segura, nunca cobra o plano errado.
export async function startStripeCheckout(tierId, period = 'monthly') {
  if (!isStripeCardAvailable()) return { success: false, message: 'stripe_unavailable' };
  let r;
  try {
    r = await apiCall('stripe_checkout', { kind: 'storage', tier: tierId, period }, 'POST');
  } catch (e) {
    return { success: false, message: e?.message || 'network' };
  }
  const url = r?.data?.url;
  if (!r?.success || typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { success: false, message: r?.message || 'checkout_failed' };
  }
  return _openAndRefresh(url);
}

// Portal do Stripe: trocar/remover cartao, cancelar assinatura.
export async function openStripePortal() {
  if (!isStripeCardAvailable()) return { success: false, message: 'stripe_unavailable' };
  let r;
  try {
    r = await apiCall('stripe_portal', {}, 'POST');
  } catch (e) {
    return { success: false, message: e?.message || 'network' };
  }
  const url = r?.data?.url;
  if (!r?.success || typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { success: false, message: r?.message || 'portal_failed' };
  }
  return _openAndRefresh(url);
}
