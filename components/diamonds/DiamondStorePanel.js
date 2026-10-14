/**
 * DiamondStorePanel — a loja de diamantes (conteúdo), usada pela tela
 * /diamond-shop e pelo DiamondTopUpSheet (recarga rápida).
 *
 * Plataforma (regras de loja):
 *   iOS     → SÓ compra in-app (StoreKit). Nenhum cartão/link externo (3.1.1).
 *   Android → SÓ Google Play Billing. Produto que a Play não devolveu = "Em breve".
 *   Web     → cartão via Stripe (WebDiamondCheckout).
 * Preço exibido = preço LOCAL da loja (localizedPrice/displayPrice); sem
 * catálogo da loja o pacote fica "Em breve" (não tocável).
 * "Restaurar compras pendentes" reenvia ao servidor o que a loja ainda tem em
 * aberto (idempotente por transaction_id — nunca credita 2x).
 * Menor de idade (parental) / servidor desligado → loja bloqueada com aviso.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, AppState } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import { IconDiamond } from '../Icons';
import { formatInt } from '../../utils/dateFormat';
import { DIAMONDS_IAP_ENABLED } from '../../constants/featureFlags';
import {
  DIAMOND_PACKS, getDiamondLocalizedPrice, initIAP, purchaseDiamonds, isDiamondSkuAvailable, restoreDiamondPurchases,
} from '../../services/iap';
import { useWallet, refreshWallet, setDiamondBalance, isMinorAccount } from '../../services/diamonds';
import WebDiamondCheckout from './WebDiamondCheckout';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
function brl(v) {
  const n = Number(v) || 0;
  try { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); } catch { return 'R$ ' + n.toFixed(2).replace('.', ','); }
}

const FEATURED = 6000;

export default function DiamondStorePanel({ compact = false, onBalanceChange }) {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
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
  const purchaseOff = wallet.loaded && (!wallet.enabled || !wallet.purchaseEnabled);

  useEffect(() => { refreshWallet(); }, []);
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
    if (isWeb) return !!stripeKey;
    if (!DIAMONDS_IAP_ENABLED || iapState !== 'ready') return false;
    return isDiamondSkuAvailable(p.sku);
  }, [isWeb, stripeKey, iapState]);

  const onBuy = useCallback(async (pack) => {
    if (pendingSku || minor || purchaseOff) return;
    setBanner(null);
    if (isWeb) { setWebPack(pack); return; }
    setPendingSku(pack.sku);
    try {
      const r = await purchaseDiamonds(pack.sku);
      if (r?.success) {
        if (typeof r.diamondBalance === 'number') setDiamondBalance(r.diamondBalance);
        refreshWallet();
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
  }, [pendingSku, minor, purchaseOff, isWeb, t, language]);

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

  const ink = colors.text;
  const sub = colors.textSecondary || ink;
  const line = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const tile = isDark ? 'rgba(255,255,255,0.04)' : '#fff';
  const allSoon = !isWeb && packs.every(p => !available(p));

  let blockText = '';
  if (minor) blockText = tr(t, 'diamondShop.minorBlocked', 'Compras não estão disponíveis para contas supervisionadas.');
  else if (purchaseOff) blockText = tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.');

  return (
    <View>
      {!compact ? (
        <View style={[styles.hero, { borderColor: line, backgroundColor: tile }]}>
          <Text style={[styles.heroLabel, { color: sub }]}>{tr(t, 'wallet.currentBalance', 'Saldo atual')}</Text>
          <View style={styles.heroRow}>
            <IconDiamond size={30} />
            <Text style={[styles.heroValue, { color: (wallet.diamonds ?? 0) < 0 ? '#E5484D' : ink }]}>
              {wallet.diamonds == null ? '—' : formatInt(wallet.diamonds, language)}
            </Text>
          </View>
          <Text style={[styles.heroSub, { color: sub }]}>
            {tr(t, 'diamondShop.heroSubtitle2', 'Use diamantes para mandar presentes em lives, reels, posts e no chat.')}
          </Text>
        </View>
      ) : null}

      {blockText ? <Text style={[styles.notice, { color: sub, borderColor: line }]}>{blockText}</Text> : null}
      {banner ? (
        <Text style={[styles.notice, { color: banner.tone === 'warn' ? '#E5484D' : ink, borderColor: line }]} accessibilityLiveRegion="polite">{banner.text}</Text>
      ) : null}

      {isWeb && webPacks === null ? <ActivityIndicator style={{ marginVertical: 24 }} color={ink} /> : null}

      {packs.map((p) => {
        const ok = available(p) && !blockText;
        const store = !isWeb ? getDiamondLocalizedPrice(p.sku) : '';
        const priceLabel = isWeb ? brl(p.priceBrl) : (store || '');
        const soon = !isWeb && !available(p);
        const loading = pendingSku === p.sku;
        const featured = p.diamonds === FEATURED && ok;
        return (
          <TouchableOpacity
            key={p.sku}
            onPress={() => onBuy(p)}
            disabled={!ok || !!pendingSku}
            activeOpacity={0.85}
            style={[styles.pack, { borderColor: featured ? ink : line, backgroundColor: tile, opacity: ok ? 1 : 0.55 }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ok }}
            accessibilityLabel={`${p.diamonds} ${tr(t, 'wallet.diamondsLabel', 'diamantes')}, ${soon ? tr(t, 'common.comingSoon', 'Em breve') : priceLabel}`}
          >
            <IconDiamond size={24} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.packN, { color: ink }]}>{formatInt(p.diamonds, language)}</Text>
              <View style={styles.tags}>
                {p.bonusPct > 0 ? (
                  <Text style={[styles.tag, { color: ink, borderColor: line }]}>{tr(t, 'wallet.topupBonus', 'Bônus +{p}%').replace('{p}', String(p.bonusPct))}</Text>
                ) : null}
                {featured ? <Text style={[styles.tag, styles.tagInk, { backgroundColor: ink, color: isDark ? '#000' : '#fff' }]}>{tr(t, 'diamondShop.bestValue', 'Melhor oferta')}</Text> : null}
              </View>
            </View>
            {loading ? <ActivityIndicator color={ink} /> : (
              <View style={[styles.buy, { backgroundColor: ok ? ink : 'transparent', borderColor: line }]}>
                <Text style={[styles.buyText, { color: ok ? (isDark ? '#000' : '#fff') : sub }]}>
                  {soon ? tr(t, 'common.comingSoon', 'Em breve') : priceLabel || '—'}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}

      {!isWeb && iapState === 'connecting' ? (
        <Text style={[styles.hint, { color: sub }]}>
          {Platform.OS === 'ios' ? tr(t, 'wallet.topupConnecting', 'Conectando à App Store…') : tr(t, 'wallet.topupConnectingAndroid', 'Conectando ao Google Play…')}
        </Text>
      ) : null}
      {!isWeb && iapState !== 'connecting' && allSoon ? (
        <Text style={[styles.hint, { color: sub }]}>
          {Platform.OS === 'android'
            ? tr(t, 'diamondShop.androidSoon', 'A compra de diamantes pelo Google Play chega em breve.')
            : tr(t, 'diamondShop.iosSoon', 'Os pacotes de diamantes estão chegando à App Store.')}
        </Text>
      ) : null}
      {isWeb && webPacks && !webPacks.length ? (
        <Text style={[styles.hint, { color: sub }]}>{tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.')}</Text>
      ) : null}

      {!isWeb && DIAMONDS_IAP_ENABLED ? (
        <TouchableOpacity onPress={onRestore} disabled={restoring} style={styles.restore} accessibilityRole="button">
          {restoring ? <ActivityIndicator color={ink} /> : (
            <Text style={[styles.restoreText, { color: ink }]}>{tr(t, 'diamondShop.restorePending', 'Restaurar compras pendentes')}</Text>
          )}
        </TouchableOpacity>
      ) : null}

      <Text style={[styles.tos, { color: sub }]}>
        {tr(t, 'diamondShop.tos2', 'Diamantes são créditos digitais para presentes dentro do Chatyy. Não são reembolsáveis pelo app nem conversíveis em dinheiro para quem compra. Compras reembolsadas pela loja são estornadas do saldo.')}
      </Text>

      {webPack ? (
        <WebDiamondCheckout
          pack={webPack}
          publishableKey={stripeKey}
          onClose={() => setWebPack(null)}
          onDone={(b) => { if (typeof b === 'number') setDiamondBalance(b); }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 20, alignItems: 'center', marginBottom: 16 },
  heroLabel: { fontSize: 13, fontWeight: '600' },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  heroValue: { fontSize: 38, fontWeight: '900', letterSpacing: -0.5 },
  heroSub: { fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  notice: { fontSize: 13, lineHeight: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginBottom: 12 },
  pack: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 14, marginBottom: 10 },
  packN: { fontSize: 20, fontWeight: '900' },
  tags: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  tag: { fontSize: 11, fontWeight: '800', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  tagInk: { borderWidth: 0 },
  buy: { minWidth: 96, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1 },
  buyText: { fontSize: 14, fontWeight: '800' },
  hint: { fontSize: 12, textAlign: 'center', marginTop: 6, lineHeight: 17 },
  restore: { alignSelf: 'center', marginTop: 14, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  restoreText: { fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
  tos: { fontSize: 11, textAlign: 'center', marginTop: 10, lineHeight: 15 },
});
