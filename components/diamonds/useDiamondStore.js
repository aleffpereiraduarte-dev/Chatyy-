/**
 * useDiamondStore — lógica ÚNICA de compra de diamantes (extraída do
 * DiamondStorePanel em 2026-10-14 p/ a carteira repaginada usar o mesmo
 * fluxo no carrossel "Mais vendidos").
 *
 * Plataforma (regras de loja — NÃO mudar sem revisar App Review 3.1.1):
 *   iOS     → SÓ compra in-app (StoreKit). Nenhum cartão/link externo.
 *   Android → SÓ Google Play Billing. Produto que a Play não devolveu = "Em breve".
 *   Web     → cartão via Stripe (WebDiamondCheckout, devolvido em `checkout`).
 * Preço exibido = preço LOCAL da loja; sem catálogo → "Em breve" (não tocável).
 * Menor de idade / servidor desligado → bloqueado (blockText).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, AppState } from 'react-native';
import * as api from '../../services/api';
import { formatInt } from '../../utils/dateFormat';
import { DIAMONDS_IAP_ENABLED } from '../../constants/featureFlags';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, getDiamondStoreUnitPrice, initIAP, purchaseDiamonds, isDiamondSkuAvailable, restoreDiamondPurchases,
} from '../../services/iap';
import { useWallet, refreshWallet, setDiamondBalance, isMinorAccount } from '../../services/diamonds';
import { haptic } from '../../constants/theme';
import WebDiamondCheckout from './WebDiamondCheckout';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
export function brl(v) {
  const n = Number(v) || 0;
  try { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); } catch { return 'R$ ' + n.toFixed(2).replace('.', ','); }
}

export default function useDiamondStore({ t, language, onBalanceChange } = {}) {
  const wallet = useWallet();
  const isWeb = Platform.OS === 'web';
  const native = Platform.OS === 'ios' || Platform.OS === 'android';
  const [iapState, setIapState] = useState(native && DIAMONDS_IAP_ENABLED ? 'connecting' : 'off'); // connecting | ready | off
  const [pendingSku, setPendingSku] = useState(null);
  const [banner, setBanner] = useState(null); // { tone: 'ok'|'warn', text }
  const [restoring, setRestoring] = useState(false);
  const [webPacks, setWebPacks] = useState(null);
  const [stripeKey, setStripeKey] = useState('');
  const [webPack, setWebPack] = useState(null);

  const minor = isMinorAccount();
  // [2026-10-18 stripe-off] web: sem checkout Stripe (compra só pelo app). Kill switch globalThis.__chatyy_stripe_checkout.
  let _stripeOn = false;
  try { _stripeOn = globalThis.__chatyy_stripe_checkout === true; } catch {}
  const webStoreOnly = isWeb && !_stripeOn;
  const purchaseOff = wallet.loaded && (!wallet.enabled || !wallet.purchaseEnabled);

  useEffect(() => { if (typeof wallet.diamonds === 'number') onBalanceChange?.(wallet.diamonds); }, [wallet.diamonds, onBalanceChange]);

  useEffect(() => {
    if (!native || !DIAMONDS_IAP_ENABLED) return undefined;
    let alive = true;
    initIAP().then((ok) => { if (alive) setIapState(ok ? 'ready' : 'off'); }).catch(() => { if (alive) setIapState('off'); });
    return () => { alive = false; };
  }, [native]);

  useEffect(() => {
    if (!isWeb) return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await api.stripeDiamondPacks?.();
        const d = r?.data || {};
        if (!alive) return;
        if (Array.isArray(d.packs) && d.packs.length) {
          // Uma linha por quantidade de diamantes (o catálogo do Stripe pode ter
          // SKUs singulares e plurais com o mesmo total).
          const seen = new Set();
          const list = [];
          for (const p of d.packs) {
            const n = Number(p.diamonds) || 0;
            if (!n || seen.has(n)) continue;
            seen.add(n);
            list.push({ sku: p.sku, diamonds: n, priceBrl: Number(p.priceBrl) || 0, bonusPct: Number(p.bonusPct) || 0 });
          }
          list.sort((a, b) => a.diamonds - b.diamonds);
          setWebPacks(list);
        } else setWebPacks([]);
        setStripeKey(d.publishable_key || '');
        if (d.configured === false) setWebPacks([]);
      } catch { if (alive) setWebPacks([]); }
    })();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refreshWallet(); });
    return () => { alive = false; try { sub.remove(); } catch {} };
  }, [isWeb]);

  const packs = useMemo(() => (isWeb ? (webPacks || []) : DIAMOND_PACKS), [isWeb, webPacks]);

  const available = useCallback((p) => {
    if (isWeb) return !webStoreOnly && !!stripeKey;
    if (!DIAMONDS_IAP_ENABLED || iapState !== 'ready') return false;
    return isDiamondSkuAvailable(p.sku);
  }, [isWeb, webStoreOnly, stripeKey, iapState]);

  let blockText = '';
  if (minor) blockText = tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.');
  else if (purchaseOff) blockText = tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.');

  const priceLabel = useCallback((p) => (isWeb ? brl(p.priceBrl) : (getDiamondLocalizedPrice(p.sku) || '')), [isWeb]);
  const isSoon = useCallback((p) => !isWeb && !available(p), [isWeb, available]);
  const canBuy = useCallback((p) => available(p) && !blockText, [available, blockText]);

  const onBuy = useCallback(async (pack) => {
    if (pendingSku || minor || purchaseOff) return;
    setBanner(null);
    if (isWeb) { if (!webStoreOnly) setWebPack(pack); return; }
    setPendingSku(pack.sku);
    try {
      const r = await purchaseDiamonds(pack.sku);
      if (r?.success) {
        if (typeof r.diamondBalance === 'number') setDiamondBalance(r.diamondBalance);
        refreshWallet();
        try { haptic.success(); } catch {}
        setBanner({ tone: 'ok', text: tr(t, 'wallet.topupSuccessBody', 'Você ganhou {d} diamantes.').replace('{d}', formatInt(r.diamondsAdded || pack.diamonds, language)) });
        return;
      }
      const m = r?.message || '';
      const map = {
        cancelled: '',
        sandbox_not_allowed: tr(t, 'diamondShop.sandboxBlocked', 'Compra de teste (TestFlight/sandbox) não gera diamantes reais nesta conta. Nenhum valor real foi cobrado.'),
        already_claimed: tr(t, 'diamondShop.alreadyClaimed', 'Esta compra já foi usada em outra conta.'),
        minor_blocked: tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.'),
        timeout: tr(t, 'diamondShop.pendingCredit', 'Pagamento em processamento. Os diamantes entram assim que a loja confirmar — toque em "Restaurar compras pendentes" se demorar.'),
        verify_failed: tr(t, 'diamondShop.pendingCredit', 'Pagamento em processamento. Os diamantes entram assim que a loja confirmar — toque em "Restaurar compras pendentes" se demorar.'),
        sku_not_in_catalog: tr(t, 'diamondShop.packSoon', 'Este pacote chega em breve.'),
        iap_unavailable: tr(t, 'wallet.topupUnavailableBody', 'Não conseguimos iniciar a compra. Tente novamente em alguns minutos.'),
      };
      const txt = m in map ? map[m] : tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.');
      if (txt) setBanner({ tone: m === 'timeout' || m === 'verify_failed' ? 'ok' : 'warn', text: txt });
    } catch {
      setBanner({ tone: 'warn', text: tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.') });
    } finally {
      setPendingSku(null);
    }
  }, [pendingSku, minor, purchaseOff, isWeb, webStoreOnly, t, language]);

  const onRestore = useCallback(async () => {
    if (restoring) return;
    setRestoring(true); setBanner(null);
    try {
      const r = await restoreDiamondPurchases();
      await refreshWallet();
      setBanner({ tone: 'ok', text: r?.count ? tr(t, 'diamondShop.restoredN', '{n} compra(s) verificada(s). Saldo atualizado.').replace('{n}', String(r.count)) : tr(t, 'diamondShop.restoredNone', 'Nenhuma compra pendente.') });
    } catch {
      setBanner({ tone: 'warn', text: tr(t, 'wallet.topupFailed', 'Falha na compra. Tente novamente.') });
    } finally { setRestoring(false); }
  }, [restoring, t]);

  // "≈ valor de compra" do saldo na moeda/preço que a LOJA mostra a esta pessoa:
  // nativo = preço StoreKit/Play do pacote base; web = preço Stripe (BRL).
  // Sem preço da loja → '' (a UI omite; nada de câmbio estimado).
  const refValue = useCallback((diamonds) => {
    const n = Number(diamonds) || 0;
    if (n <= 0) return '';
    let unit = null;
    if (isWeb) {
      const base = (webPacks || []).find((p) => p.priceBrl > 0 && p.diamonds > 0 && !p.bonusPct) || (webPacks || []).find((p) => p.priceBrl > 0 && p.diamonds > 0);
      if (base) unit = { currency: 'BRL', perDiamond: base.priceBrl / base.diamonds };
    } else if (iapState === 'ready') {
      unit = getDiamondStoreUnitPrice();
    }
    if (!unit) return '';
    const v = n * unit.perDiamond;
    try {
      return new Intl.NumberFormat(language || undefined, { style: 'currency', currency: unit.currency, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
    } catch {
      return unit.currency + ' ' + v.toFixed(2);
    }
  }, [isWeb, webPacks, iapState, language]);

  const allSoon = !isWeb && packs.length > 0 && packs.every((p) => !available(p));

  const checkout = (webPack && !webStoreOnly) ? (
    <WebDiamondCheckout
      pack={webPack}
      publishableKey={stripeKey}
      onClose={() => setWebPack(null)}
      onDone={(b) => { if (typeof b === 'number') setDiamondBalance(b); refreshWallet(); }}
    />
  ) : null;

  return {
    wallet, isWeb, packs, webPacks, iapState, pendingSku, banner, setBanner, restoring,
    available, priceLabel, isSoon, canBuy, onBuy, onRestore, blockText, allSoon, checkout, refValue,
    restoreAvailable: !isWeb && DIAMONDS_IAP_ENABLED,
    webStoreOnly,
  };
}
