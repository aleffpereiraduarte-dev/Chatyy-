/**
 * DiamondStorePanel — a loja de diamantes (conteúdo), usada pela tela
 * /diamond-shop e pelo DiamondTopUpSheet (recarga rápida).
 *
 * [2026-10-14 carteira-v3] Visual fintech P&B coerente com a Carteira: herói
 * grafite (só na tela cheia) + grade de pacotes (PackCard) com preço LOCAL da
 * loja e bônus em badge. A lógica de compra mora em useDiamondStore:
 *   iOS     → SÓ compra in-app (StoreKit). Nenhum cartão/link externo (3.1.1).
 *   Android → SÓ Google Play Billing. Produto que a Play não devolveu = "Em breve".
 *   Web     → cartão via Stripe (WebDiamondCheckout).
 * "Restaurar compras pendentes" reenvia ao servidor o que a loja ainda tem em
 * aberto (idempotente por transaction_id — nunca credita 2x).
 * Menor de idade (parental) / servidor desligado → loja bloqueada com aviso.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { formatInt } from '../../utils/dateFormat';
import { refreshWallet } from '../../services/diamonds';
import { useSurface, PressableScale, FadeSlideIn, Type, Space, Radius } from '../ui';
import { HeroCard, HERO, AnimatedNumber, DiamondMark, PackCard, TABULAR, NOFLEX, tr } from '../wallet/WalletKit';
import useDiamondStore from './useDiamondStore';
import SubscribeInAppCard from '../SubscribeInAppCard'; // [2026-10-18 stripe-off]

const POPULAR = 1700;
const BEST = 6000;

export default function DiamondStorePanel({ compact = false, onBalanceChange }) {
  const { isDark } = useTheme();
  const { t, language } = useLanguage();
  const s = useSurface();
  const store = useDiamondStore({ t, language, onBalanceChange });
  const { wallet, packs, isWeb, webPacks, iapState, banner, blockText } = store;
  const [w, setW] = useState(0);

  useEffect(() => { refreshWallet(); }, []);

  const cols = w >= 520 ? 3 : 2;
  const gap = Space.sm;
  const tileW = w > 0 ? Math.floor((w - gap * (cols - 1)) / cols) : 0;
  const negative = (wallet.diamonds ?? 0) < 0;

  return (
    <View onLayout={(e) => { const nw = e.nativeEvent.layout.width; if (Math.abs(nw - w) > 1) setW(nw); }}>
      {!compact ? (
        <FadeSlideIn style={NOFLEX}>
          <HeroCard isDark={isDark} style={{ marginBottom: Space.xl }}>
            <Text style={[styles.heroCaps, { color: HERO.sub }]}>{tr(t, 'wallet.currentBalance', 'Saldo atual')}</Text>
            <View style={styles.heroRow}>
              <DiamondMark size={28} />
              <AnimatedNumber
                value={typeof wallet.diamonds === 'number' ? wallet.diamonds : null}
                format={(n) => formatInt(n, language)}
                style={[styles.heroValue, { color: negative ? HERO.danger : HERO.text }]}
                adjustsFontSizeToFit minimumFontScale={0.6}
              />
            </View>
            <Text style={[Type.footnote, { color: HERO.sub, marginTop: Space.xs }]}>
              {tr(t, 'diamondShop.heroSubtitle2', 'Use diamantes para mandar presentes em lives, reels, posts e no chat.')}
            </Text>
          </HeroCard>
        </FadeSlideIn>
      ) : (
        <View style={[styles.compactBal, { backgroundColor: s.fill }]}>
          <Text style={[Type.footnote, { color: s.textSecondary }]}>{tr(t, 'wallet.currentBalance', 'Saldo atual')}</Text>
          <View style={styles.compactRight}>
            <Text style={[Type.headline, TABULAR, { color: negative ? s.danger : s.text }]}>{wallet.diamonds == null ? '—' : formatInt(wallet.diamonds, language)}</Text>
            <DiamondMark size={14} halo={false} />
          </View>
        </View>
      )}

      {!compact ? (
        <Text style={[Type.title3, { color: s.text, fontWeight: '700', marginBottom: Space.md }]} accessibilityRole="header">
          {tr(t, 'walletV3.choosePack', 'Escolha um pacote')}
        </Text>
      ) : null}

      {store.webStoreOnly ? (
        <SubscribeInAppCard title={t('storeOnly.diamondsTitle')} body={t('storeOnly.diamondsBody')} style={{ marginBottom: 16 }} />
      ) : null}
      {blockText ? <Text style={[styles.notice, { color: s.textSecondary, borderColor: s.separator }]}>{blockText}</Text> : null}
      {banner ? (
        <Text style={[styles.notice, { color: banner.tone === 'warn' ? s.danger : s.text, borderColor: s.separator }]} accessibilityLiveRegion="polite">{banner.text}</Text>
      ) : null}

      {isWeb && webPacks === null ? <ActivityIndicator style={{ marginVertical: 24 }} color={s.textSecondary} /> : null}

      {tileW > 0 ? (
        <View style={[styles.grid, { gap }]}>
          {packs.map((p, i) => {
            // Último pacote sozinho na linha ocupa a largura toda.
            const lone = i === packs.length - 1 && packs.length % cols === 1;
            const ok = store.canBuy(p);
            const n = Number(p.diamonds);
            const featured = (n === BEST || n === POPULAR) && ok;
            return (
              <View key={p.sku} style={{ width: lone ? w : tileW }}>
                <PackCard
                  pack={p} s={s} t={t} language={language}
                  price={store.priceLabel(p)}
                  soon={store.isSoon(p)}
                  disabled={!ok || !!store.pendingSku}
                  loading={store.pendingSku === p.sku}
                  highlight={featured}
                  badge={!ok ? undefined : n === BEST ? tr(t, 'diamondShop.bestValue', 'Melhor oferta') : n === POPULAR ? tr(t, 'walletV3.popular', 'Mais popular') : undefined}
                  onPress={() => store.onBuy(p)}
                />
              </View>
            );
          })}
        </View>
      ) : null}

      {!isWeb && iapState === 'connecting' ? (
        <Text style={[styles.hint, { color: s.textSecondary }]}>
          {Platform.OS === 'ios' ? tr(t, 'wallet.topupConnecting', 'Conectando à App Store…') : tr(t, 'wallet.topupConnectingAndroid', 'Conectando ao Google Play…')}
        </Text>
      ) : null}
      {!isWeb && iapState !== 'connecting' && store.allSoon ? (
        <Text style={[styles.hint, { color: s.textSecondary }]}>
          {Platform.OS === 'android'
            ? tr(t, 'diamondShop.androidSoon', 'A compra de diamantes pelo Google Play chega em breve.')
            : tr(t, 'diamondShop.iosSoon', 'Os pacotes de diamantes estão chegando à App Store.')}
        </Text>
      ) : null}
      {isWeb && webPacks && !webPacks.length ? (
        <Text style={[styles.hint, { color: s.textSecondary }]}>{tr(t, 'diamondShop.purchasesOff', 'Compras de diamantes indisponíveis no momento.')}</Text>
      ) : null}

      {store.restoreAvailable ? (
        <PressableScale onPress={store.onRestore} disabled={store.restoring} haptic="light" style={styles.restore} accessibilityRole="button">
          {store.restoring ? <ActivityIndicator color={s.text} /> : (
            <Text style={[styles.restoreText, { color: s.text }]}>{tr(t, 'diamondShop.restorePending', 'Restaurar compras pendentes')}</Text>
          )}
        </PressableScale>
      ) : null}

      <Text style={[styles.tos, { color: s.textTertiary }]}>
        {tr(t, 'diamondShop.tos2', 'Diamantes são créditos digitais para presentes dentro do Chatyy. Não são reembolsáveis pelo app nem conversíveis em dinheiro para quem compra. Compras reembolsadas pela loja são estornadas do saldo.')}
      </Text>

      {store.checkout}
    </View>
  );
}

const styles = StyleSheet.create({
  heroCaps: { fontSize: 12, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase' },
  heroRow: { flexDirection: 'row', alignItems: 'center', marginTop: Space.xs, marginLeft: -8 },
  heroValue: { flex: 1, fontSize: 42, lineHeight: 50, fontWeight: '700', letterSpacing: -1.2, marginLeft: 2 },
  compactBal: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: Radius.control + 2, paddingHorizontal: Space.md, height: 44, marginBottom: Space.md },
  compactRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  notice: { fontSize: 13, lineHeight: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  hint: { fontSize: 12, textAlign: 'center', marginTop: Space.md, lineHeight: 17 },
  restore: { alignSelf: 'center', marginTop: Space.lg, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  restoreText: { fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  tos: { fontSize: 11, textAlign: 'center', marginTop: Space.md, lineHeight: 15, paddingHorizontal: Space.sm },
});
