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

// [2026-10-18 stripe-off] Founder: compra NOVA só nas lojas (App Store / Google Play).
// Kill switch globalThis.__chatyy_stripe_checkout (default OFF = checkout Stripe some).
// O servidor também recusa (stripe_disabled) sem STRIPE_CHECKOUT_ENABLED=1.
export function isStripeCheckoutEnabled() {
  try { return globalThis.__chatyy_stripe_checkout === true; } catch { return false; }
}

// Pode COMPRAR com cartão (Stripe)? Só com o kill switch ligado e fora do iOS.
export function isStripeCardAvailable() {
  return STRIPE_ENABLED && Platform.OS !== 'ios' && isStripeCheckoutEnabled();
}

// Assinantes Stripe existentes continuam podendo gerenciar/cancelar (portal), fora do iOS.
export function isStripePortalAvailable() {
  return Platform.OS !== 'ios';
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
  // Browser fechado (sucesso OU cancelamento). [2026-10-16 storage-billing] O webhook
  // da Stripe NAO esta registrado p/ o Chatyy: o servidor confere a assinatura direto
  // na API (stripe_storage_sync) e aplica a cota; depois re-buscamos o plano.
  await syncStripeStorage();
  let plan = null;
  try { plan = await planInfo(); } catch {}
  return { success: true, opened: true, browserResult: result?.type || null, plan };
}

/** [2026-10-16 storage-billing] Aplica no servidor o armazenamento pago com cartão. */
export async function syncStripeStorage() {
  try {
    const r = await apiCall('stripe_storage_sync', {}, 'POST');
    return r?.success ? (r.data || null) : null;
  } catch { return null; }
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
    // [2026-10-18 stripe-off] servidor recusa compra nova por Stripe → UI mostra "Assine pelo app"
    if (r?.data?.error_code === 'stripe_disabled' || r?.message === 'stripe_disabled') return { success: false, message: 'stripe_disabled' };
    return { success: false, message: r?.message || 'checkout_failed' };
  }
  // [2026-10-16 storage-billing] Web: popup aberto depois de um await é bloqueado pelo
  // navegador → mesma aba; a Stripe volta em /plans?storage=1&success=1 (que sincroniza).
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    try { window.location.assign(url); return { success: true, redirected: true }; } catch {}
  }
  return _openAndRefresh(url);
}

// Portal do Stripe: trocar/remover cartao, cancelar assinatura.
export async function openStripePortal() {
  if (!isStripePortalAvailable()) return { success: false, message: 'stripe_unavailable' };
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
