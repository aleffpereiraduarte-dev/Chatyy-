// [2026-10-20 plano-premium] Preços/compra/gestão das assinaturas Plus/Pro para a
// tela do plano (components/plan/PlanHub.js). Compra SÓ pelas lojas (Apple IAP /
// Google Play Billing, via services/iap.js + expo-iap já no binário). Stripe
// desligado para compra nova; assinante Stripe antigo continua no portal.
//
// Preço exibido = o da LOJA (StoreKit / Play, já na moeda do usuário). Sem
// produto da loja (web, Play sem produto, StoreKit ainda carregando) → preço de
// referência do catálogo do servidor (plan_info.catalog, BRL) marcado `store:false`.
import { Platform, Linking } from 'react-native';
import * as IAP from './iap';
import { formatPlanMoney, formatBRLCents, normalizeStoreProduct } from '../utils/planPricing';
import { FALLBACK_CATALOG } from './planState';

export const ANDROID_PACKAGE = 'com.onemundo.mail';
export const PAID_PLANS = ['plus', 'pro'];
export const PLAN_RANK = { free: 0, plus: 1, pro: 2 };

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

/** Liga a loja (idempotente). true = StoreKit/Play conectado. */
export async function ensureStore() {
  if (!NATIVE) return false;
  try { return !!(await IAP.initIAP()); } catch { return false; }
}

function _androidPrice(planId, period) {
  const sku = planId === 'pro' ? 'chatyy_pro' : 'chatyy_plus';
  const basePlanId = period === 'annual' ? 'annual' : 'monthly';
  let products = [];
  try { products = IAP.getProducts() || []; } catch {}
  const p = products.find((x) => (x?.id || x?.productId) === sku);
  const offers = p?.subscriptionOfferDetailsAndroid || p?.subscriptionOfferDetails || [];
  const own = offers.filter((o) => o?.basePlanId === basePlanId);
  if (!own.length) return null;
  const base = own.find((o) => !o?.offerId) || own[0];
  const phases = base?.pricingPhases?.pricingPhaseList || [];
  if (!phases.length) return null;
  const last = phases[phases.length - 1];
  const amount = Number(last.priceAmountMicros) / 1e6;
  const trialOffer = own.find((o) => (o?.pricingPhases?.pricingPhaseList || []).some((ph) => String(ph.priceAmountMicros) === '0'));
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency: last.priceCurrencyCode || null,
    display: last.formattedPrice || '',
    trial: !!trialOffer,
  };
}

function _iosPrice(planId, period) {
  let raw = null;
  try { raw = IAP.getStoreProduct(IAP.getProductId(planId, period)); } catch {}
  const n = normalizeStoreProduct(raw);
  if (!n) return null;
  const mode = raw?.introductoryPricePaymentModeIOS || raw?.subscriptionInfoIOS?.introductoryOffer?.paymentMode || '';
  return { ...n, trial: String(mode).toLowerCase().replace(/_/g, '-') === 'free-trial' || String(mode).toUpperCase() === 'FREETRIAL' };
}

/** Preço da loja { amount, currency, display, trial } ou null. */
export function storePrice(planId, period) {
  if (!PAID_PLANS.includes(planId)) return null;
  try {
    if (Platform.OS === 'ios') return _iosPrice(planId, period);
    if (Platform.OS === 'android') return _androidPrice(planId, period);
  } catch {}
  return null;
}

/**
 * Preço para a UI de um plano/período.
 * { label, perMonthLabel, amount, currency, store, trial }
 *  - label = valor cobrado no período (mês ou ano)
 *  - perMonthLabel = equivalente mensal (só anual)
 */
export function planPrice(planId, period, catalog, lang) {
  if (planId === 'free') return { label: formatPlanMoney(0, 'BRL', lang), amount: 0, currency: 'BRL', store: false };
  const sp = storePrice(planId, period);
  if (sp && (sp.display || (sp.amount != null && sp.currency))) {
    const label = sp.display || formatPlanMoney(sp.amount, sp.currency, lang);
    const perMonthLabel = period === 'annual' && sp.amount != null && sp.currency ? formatPlanMoney(sp.amount / 12, sp.currency, lang) : null;
    return { label, perMonthLabel, amount: sp.amount, currency: sp.currency, store: true, trial: !!sp.trial };
  }
  const c = (catalog && catalog[planId]) || FALLBACK_CATALOG[planId] || {};
  const cents = period === 'annual' ? Number(c.price_annual_cents) || 0 : Number(c.price_cents) || 0;
  if (!cents) return null;
  return {
    label: formatBRLCents(cents, lang),
    perMonthLabel: period === 'annual' ? formatBRLCents(cents / 12, lang) : null,
    amount: cents / 100, currency: 'BRL', store: false, trial: false,
  };
}

/** Economia do anual em % (mensal×12 vs anual, mesma moeda). null = não dá pra calcular. */
export function annualSavingsPct(planId, catalog, lang) {
  const m = planPrice(planId, 'monthly', catalog, lang);
  const y = planPrice(planId, 'annual', catalog, lang);
  if (!m || !y || m.amount == null || y.amount == null || m.currency !== y.currency) return null;
  if (m.store !== y.store) return null; // nunca mistura preço da loja com referência
  const full = m.amount * 12;
  if (!(full > 0) || y.amount >= full) return null;
  const pct = Math.round((1 - y.amount / full) * 100);
  return pct >= 1 ? pct : null;
}

/** Existe produto anual (loja) — ou, fora da loja, catálogo com preço anual. */
export function hasAnnual(catalog) {
  if (NATIVE) {
    const any = PAID_PLANS.some((p) => !!storePrice(p, 'annual'));
    if (any) return true;
    // loja sem produtos (ex.: Play sem assinatura criada) → referência do catálogo
    return !PAID_PLANS.some((p) => !!storePrice(p, 'monthly')) && PAID_PLANS.some((p) => Number(((catalog || FALLBACK_CATALOG)[p] || {}).price_annual_cents) > 0);
  }
  return PAID_PLANS.some((p) => Number(((catalog || FALLBACK_CATALOG)[p] || {}).price_annual_cents) > 0);
}

/** Compra (abre a folha da loja). Lança Error('CANCELLED') se o usuário cancelar. */
export async function purchasePlan(planId, period) {
  await ensureStore();
  const productId = IAP.getProductId(planId, period === 'annual' ? 'annual' : 'monthly');
  return IAP.purchaseSubscription(productId);
}

export async function restore() {
  await ensureStore();
  return IAP.restorePurchases();
}

/** Assinaturas da Apple (folha nativa) / Google Play. */
export async function openStoreSubscriptions(planId) {
  if (Platform.OS === 'ios') {
    try {
      const m = require('expo-iap');
      if (m && typeof m.deepLinkToSubscriptions === 'function') { await m.deepLinkToSubscriptions(); return true; }
    } catch {}
    try { await Linking.openURL('https://apps.apple.com/account/subscriptions'); return true; } catch { return false; }
  }
  const sku = planId === 'pro' ? 'chatyy_pro' : planId === 'plus' ? 'chatyy_plus' : '';
  const url = 'https://play.google.com/store/account/subscriptions?package=' + ANDROID_PACKAGE + (sku ? '&sku=' + sku : '');
  try { await Linking.openURL(url); return true; } catch { return false; }
}

/** Histórico de compras/recibos da própria loja (não há endpoint nosso de recibos). */
export function purchaseHistoryUrl() {
  if (Platform.OS === 'ios') return 'https://reportaproblem.apple.com/';
  if (Platform.OS === 'android') return 'https://play.google.com/store/account/orderhistory';
  return null;
}

export function termsUrl() {
  return Platform.OS === 'ios' ? 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' : 'https://chatyy.app/terms.html';
}
export const PRIVACY_URL = 'https://chatyy.app/privacy.html';
export const SUPPORT_URL = 'https://chatyy.app/suporte/';

/** "DD/MM/AAAA" (ou null). Aceita ISO, "YYYY-MM-DD HH:MM:SS" e epoch (s/ms). */
export function fmtDMY(v) {
  if (v == null || v === '') return null;
  let d;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    // PG: "2027-04-29 08:26:48.635573+00" → ISO válido (ms + offset com minutos)
    const iso = String(v).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00');
    d = new Date(iso);
    if (isNaN(d.getTime())) d = new Date(String(v).slice(0, 10) + 'T12:00:00');
  }
  if (isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export default {
  ensureStore, storePrice, planPrice, annualSavingsPct, hasAnnual, purchasePlan, restore,
  openStoreSubscriptions, purchaseHistoryUrl, termsUrl, fmtDMY,
};
