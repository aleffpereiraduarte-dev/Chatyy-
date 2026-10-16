// components/wallet/WalletHowItWorksSheet.js — [2026-10-16 carteira-clara]
//
// "Como funciona" da Carteira (folha P&B curta). Deixa claro o que é sacável:
//   • diamantes COMPRADOS = só para presentear (regra das lojas + antifraude);
//   • GANHOS = presentes que você recebe, em reais;
//   • liberação (dias), mínimo e Pix.
// Valores vêm do SERVIDOR (useWallet: minCashoutCents / holdDays /
// payoutPerDiamondMillicents). Sem valor conhecido → frase sem o número.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import { useWallet } from '../../services/diamonds';
import { Sheet, useSurface, Type, Space } from '../ui';
import { tr, moneyBRL, TxGlyph } from './WalletKit';
import { formatMoney } from '../../services/currencyService';

function Step({ s, glyph, title, body }) {
  return (
    <View style={styles.step} accessible accessibilityLabel={`${title}. ${body}`}>
      <View style={[styles.glyph, { borderColor: s.separator }]}>
        <TxGlyph name={glyph} size={20} color={s.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[Type.headline, { color: s.text }]}>{title}</Text>
        <Text style={[Type.subhead, { color: s.textSecondary, marginTop: 2 }]}>{body}</Text>
      </View>
    </View>
  );
}

export default function WalletHowItWorksSheet({ visible, onClose }) {
  const { t } = useLanguage();
  const s = useSurface();
  const w = useWallet();
  const min = Number(w.minCashoutCents) || 0;
  const days = Number(w.holdDays) || 0;
  const ppd = Number(w.payoutPerDiamondMillicents) || 0;

  const earnBody = ppd > 0
    ? tr(t, 'walletHow.earnBodyValue', 'Quando alguém te envia um presente, ele vira ganho em reais na sua conta. Cada diamante recebido vale {value}.')
      .replace('{value}', formatMoney(ppd / 1000, 'BRL', 'pt-BR'))
    : tr(t, 'walletHow.earnBody', 'Quando alguém te envia um presente, ele vira ganho em reais na sua conta.');
  const holdBody = days > 0
    ? tr(t, 'walletHow.holdBodyDays', 'Cada presente recebido fica {days} dias em liberação (prazo de reembolso das lojas). Depois disso, entra no saldo disponível para saque.').replace('{days}', String(days))
    : tr(t, 'walletHow.holdBody', 'Cada presente recebido fica alguns dias em liberação (prazo de reembolso das lojas). Depois disso, entra no saldo disponível para saque.');
  const cashBody = min > 0
    ? tr(t, 'walletHow.cashBodyMin', 'Com {min} ou mais em ganhos disponíveis, você saca via Pix para uma chave no seu CPF. Cada saque passa por análise.').replace('{min}', moneyBRL(min))
    : tr(t, 'walletHow.cashBody', 'Ao atingir o saque mínimo em ganhos disponíveis, você saca via Pix para uma chave no seu CPF. Cada saque passa por análise.');

  return (
    <Sheet visible={!!visible} onClose={onClose} scroll
      title={tr(t, 'walletHow.title', 'Como funciona')}
      subtitle={tr(t, 'walletHow.subtitle', 'Diamantes e ganhos são saldos diferentes.')}>
      <View style={styles.body}>
        <Step s={s} glyph="purchase"
          title={tr(t, 'walletHow.buyTitle', 'Diamantes comprados')}
          body={tr(t, 'walletHow.buyBody', 'Servem para enviar presentes em lives, reels, posts e conversas. Não podem ser sacados nem trocados por dinheiro — é regra da App Store e do Google Play.')} />
        <Step s={s} glyph="gift" title={tr(t, 'walletV3.earnings', 'Ganhos')} body={earnBody} />
        <Step s={s} glyph="refund" title={tr(t, 'walletV3.onHold', 'Em liberação')} body={holdBody} />
        <Step s={s} glyph="cashout" title={tr(t, 'walletHow.cashTitle', 'Saque via Pix')} body={cashBody} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: Space.xl, paddingTop: Space.sm, paddingBottom: Space.lg, gap: Space.lg },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  glyph: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
