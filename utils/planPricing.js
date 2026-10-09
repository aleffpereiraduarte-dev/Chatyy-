// [2026-10-09 plans-intl] Formatação de preço da tela de planos.
//
// - iOS (compra por IAP/StoreKit): o preço exibido é o da LOJA (displayPrice
//   + price/currency do expo-iap), já na moeda do Apple ID do usuário.
// - Web / Android (cobrança via Stripe em BRL): o valor é BRL, formatado no
//   idioma do usuário com Intl.NumberFormat ("14,99 R$" em fr, "R$14.99" em
//   en) + nota "cobrado em reais". Nunca convertemos o preço cobrado: o
//   backend (plans.php / stripe.php) só tem preços em BRL.
import { regionalLocale } from './dateFormat';

/**
 * Formata `amount` (unidades, não centavos) na moeda `currency`.
 * opts.whole=true → sem casas decimais (ex.: "economize R$ 30").
 */
export function formatPlanMoney(amount, currency, lang, opts) {
  const n = Number(amount) || 0;
  const cur = typeof currency === 'string' && currency.length === 3 ? currency.toUpperCase() : 'BRL';
  const noDecimals = !!(opts && opts.whole) || n === 0;
  let locale;
  try { locale = regionalLocale(lang) || lang || undefined; } catch { locale = lang || undefined; }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: noDecimals ? 0 : 2,
      maximumFractionDigits: noDecimals ? 0 : 2,
    }).format(noDecimals ? Math.round(n) : n);
  } catch {
    const num = noDecimals ? String(Math.round(n)) : n.toFixed(2);
    return cur === 'BRL' ? `R$ ${num.replace('.', ',')}` : `${cur} ${num}`;
  }
}

/** Centavos BRL → texto. */
export function formatBRLCents(cents, lang, opts) {
  return formatPlanMoney((Number(cents) || 0) / 100, 'BRL', lang, opts);
}

/**
 * Preço da loja (IAP) normalizado: { amount:number|null, currency:string|null, display:string } | null.
 * `product` = item devolvido por expo-iap fetchProducts().
 */
export function normalizeStoreProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const display = String(product.displayPrice || product.localizedPrice || '');
  let amount = typeof product.price === 'number' ? product.price : parseFloat(product.price);
  if (!Number.isFinite(amount) || amount <= 0) amount = null;
  const c = product.currency || product.currencyCode;
  const currency = typeof c === 'string' && c.length === 3 ? c.toUpperCase() : null;
  if (!display && (amount == null || !currency)) return null;
  return { amount, currency, display };
}
