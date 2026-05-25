// SendDiamondSheet — peer-to-peer diamond gift bottom sheet.
//
// Triggers:
//   - "Enviar diamante" chip on /u/[username] (non-self profile)
//   - Long-press → Enviar diamante on chat messages (future)
//   - Profile peek modal action row (future)
//
// Flow:
//   1. Sheet opens with receiver avatar + name in header.
//   2. User picks one of 4 quick amounts (10 / 50 / 100 / 500) or types
//      a custom value (1..max-balance).
//   3. Optional 200-char message ("Parabéns!", "Te amo", ...).
//   4. Tap "Enviar":
//        a. Optimistic UI: scale-pulse the gift, debit balance locally.
//        b. POST wallet_send. On 402 insufficient_diamonds → swap sheet
//           to DiamondTopUpSheet so the user can buy more in one tap.
//        c. On success: toast "{amount} ◆ enviados para {name}", close.
//
// Balance is live-loaded on open. We refresh after the send so the
// header chip stays in sync (the StoreKit top-up flow doesn't go
// through here).
//
// No native deps — the diamond animation is pure RN Animated. Safe to
// OTA without a rebuild.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Animated, Alert, Platform, Easing, Vibration,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { IconX, IconDiamond } from './Icons';
import { formatInt } from '../utils/dateFormat';
import AvatarCircle from './AvatarCircle';
import * as api from '../services/api';
import DiamondTopUpSheet from './DiamondTopUpSheet';
import { DIAMOND_PACKS } from '../services/iap';

// Per-diamond price in BRL centavos, derived from the shared shop catalog
// (DIAMOND_PACKS) instead of a magic number. Uses the base (no-bonus) pack so
// the estimate tracks the real list price. Currency conversion + symbol are
// handled by useCurrency().format() — BRL centavos are the canonical unit.
const _basePack = DIAMOND_PACKS[0] || { priceBrl: 4.99, diamonds: 100 };
const DIAMOND_PRICE_CENTS = (_basePack.priceBrl * 100) / _basePack.diamonds;

const QUICK_AMOUNTS = [10, 50, 100, 500];

export default function SendDiamondSheet({
  visible,
  onClose,
  toEmail,
  toName,
  toAvatarUrl,        // optional explicit avatar URL (we fall back to email-derived)
  onSent,             // ({ transferId, amount }) => void — fired after success
}) {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const { format: formatMoney } = useCurrency(language);

  const [balance, setBalance] = useState(0);
  const [loadingBal, setLoadingBal] = useState(false);
  const [amount, setAmount] = useState(50);
  const [customInput, setCustomInput] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);

  // Diamond pulse animation around the receiver avatar — fires on amount
  // change as a "preview" of the gift weight (heavier amount = bigger pulse).
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const sendAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoadingBal(true);
    setAmount(50);
    setCustomInput('');
    setMessage('');
    (async () => {
      try {
        const r = await api.walletBalance?.();
        if (alive && r?.success && r.data) {
          setBalance(Number(r.data.diamond_balance) || 0);
        }
      } catch {}
      if (alive) setLoadingBal(false);
    })();
    return () => { alive = false; };
  }, [visible]);

  // Re-trigger the pulse whenever the chosen amount changes.
  useEffect(() => {
    if (!visible) return;
    pulseAnim.setValue(0);
    Animated.timing(pulseAnim, {
      toValue: 1,
      duration: 380,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [amount, visible, pulseAnim]);

  const pickAmount = useCallback((n) => {
    setAmount(n);
    setCustomInput('');
  }, []);

  const onCustomChange = useCallback((txt) => {
    const cleaned = String(txt || '').replace(/[^0-9]/g, '').slice(0, 6);
    setCustomInput(cleaned);
    if (cleaned !== '') {
      const n = parseInt(cleaned, 10);
      if (!isNaN(n) && n > 0) setAmount(n);
    }
  }, []);

  const insufficient = useMemo(() => amount > balance, [amount, balance]);

  const onSend = useCallback(async () => {
    if (sending) return;
    if (!toEmail) return;
    if (amount < 1 || amount > 100000) {
      Alert.alert(t('common.error') || 'Erro', t('walletSend.invalidAmount') || 'Valor inválido.');
      return;
    }
    if (insufficient) {
      // Open top-up sheet instead of erroring out — keeps the user inline.
      setShowTopUp(true);
      return;
    }
    setSending(true);
    // Optimistic balance hint while the round-trip lands.
    const before = balance;
    setBalance(Math.max(0, before - amount));

    // Send animation — diamond emoji floats up.
    sendAnim.setValue(0);
    Animated.timing(sendAnim, {
      toValue: 1,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    try { Vibration?.vibrate?.(20); } catch {}

    try {
      const r = await api.walletSend(toEmail, amount, message);
      if (r?.success) {
        const newBal = Number(r.data?.diamond_balance);
        if (!isNaN(newBal)) setBalance(newBal);
        try { onSent?.({ transferId: r.data?.transfer_id, amount }); } catch {}
        Alert.alert(
          t('walletSend.sentTitle') || 'Diamantes enviados',
          (t('walletSend.sentBody') || '{n} ◆ enviados para {name}.')
            .replace('{n}', amount).replace('{name}', toName || toEmail),
        );
        onClose?.();
        return;
      }
      // Restore optimistic balance.
      setBalance(before);
      if (r?.data?.code === 'insufficient_diamonds') {
        // Rare race — backend caught it before we did.
        setShowTopUp(true);
        return;
      }
      Alert.alert(
        t('common.error') || 'Erro',
        r?.message || t('walletSend.failed') || 'Falha ao enviar diamantes.',
      );
    } catch (e) {
      setBalance(before);
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Falha ao enviar.');
    } finally {
      setSending(false);
    }
  }, [amount, balance, insufficient, message, onClose, onSent, sendAnim, sending, t, toEmail, toName]);

  const pulseScale = pulseAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 1.18, 1.0],
  });
  const sendTranslateY = sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -120] });
  const sendOpacity = sendAnim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0, 1, 0] });
  const sendScale = sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.6] });

  // Fiat estimate — derived from the shared shop catalog price-per-diamond
  // (DIAMOND_PRICE_CENTS, in BRL centavos) and rendered in the user's chosen
  // currency via useCurrency().format(), instead of a hard-coded USD/BRL rate.
  const approxFiat = useMemo(
    () => formatMoney(Math.round(amount * DIAMOND_PRICE_CENTS)),
    [amount, formatMoney]
  );

  return (
    <>
      <Modal visible={visible && !showTopUp} animationType="slide" transparent onRequestClose={onClose}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}>
            <View style={styles.head}>
              <Text style={[styles.title, { color: colors.text }]}>
                {t('walletSend.title') || 'Enviar diamantes'}
              </Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
                <IconX size={18} color={colors.text} />
              </TouchableOpacity>
            </View>

            {/* Receiver header */}
            <View style={styles.receiverRow}>
              <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
                <AvatarCircle
                  name={toName || toEmail}
                  email={toEmail}
                  uri={toAvatarUrl}
                  size={64}
                  ringColor="#FFD700"
                />
              </Animated.View>
              <Text style={[styles.receiverName, { color: colors.text }]} numberOfLines={1}>
                {toName || (toEmail || '').split('@')[0]}
              </Text>
              <Text style={[styles.receiverEmail, { color: colors.textSecondary }]} numberOfLines={1}>
                {toEmail}
              </Text>

              {/* Send-animation diamond — uses the same ◆ glyph as the
                  rest of the wallet UI (no emoji per design guidelines). */}
              <Animated.Text
                pointerEvents="none"
                style={[
                  styles.sendDiamond,
                  {
                    opacity: sendOpacity,
                    transform: [{ translateY: sendTranslateY }, { scale: sendScale }],
                  },
                ]}
              >
                ◆
              </Animated.Text>
            </View>

            {/* Balance chip */}
            <View style={styles.balanceRow}>
              <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
                {t('wallet.currentBalance') || 'Saldo atual'}:
              </Text>
              {loadingBal ? (
                <ActivityIndicator size="small" color="#A855F7" />
              ) : (
                <Text style={[styles.balanceVal, { color: insufficient ? '#EF4444' : colors.text }]}>
                  {formatInt(balance, language)} ◆
                </Text>
              )}
              <TouchableOpacity
                onPress={() => setShowTopUp(true)}
                style={styles.topUpInlineBtn}
                accessibilityRole="button"
              >
                <Text style={styles.topUpInlineText}>+ {t('wallet.topup') || 'Comprar'}</Text>
              </TouchableOpacity>
            </View>

            {/* Quick amount grid */}
            <View style={styles.amountsGrid}>
              {QUICK_AMOUNTS.map(n => {
                const active = !customInput && amount === n;
                return (
                  <TouchableOpacity
                    key={n}
                    onPress={() => pickAmount(n)}
                    style={[
                      styles.amountChip,
                      {
                        backgroundColor: active
                          ? '#A855F7'
                          : (isDark ? 'rgba(168,85,247,0.10)' : 'rgba(168,85,247,0.06)'),
                        borderColor: active ? '#A855F7' : (isDark ? 'rgba(168,85,247,0.30)' : 'rgba(168,85,247,0.22)'),
                      },
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.amountChipText, { color: active ? '#fff' : colors.text }]}>
                      {formatInt(n, language)} ◆
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom amount */}
            <View style={styles.customRow}>
              <Text style={[styles.customLabel, { color: colors.textSecondary }]}>
                {t('walletSend.customAmount') || 'Outro valor'}
              </Text>
              <TextInput
                value={customInput}
                onChangeText={onCustomChange}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.textTertiary}
                maxLength={6}
                style={[
                  styles.customInput,
                  {
                    color: colors.text,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
                    borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)',
                  },
                ]}
              />
              <Text style={[styles.customSuffix, { color: colors.textSecondary }]}>◆</Text>
            </View>

            {/* Approx fiat hint */}
            <Text style={[styles.approxNote, { color: colors.textTertiary }]}>
              ≈ {approxFiat} {t('walletSend.approxNote') || '(estimativa)'}
            </Text>

            {/* Optional message */}
            <TextInput
              value={message}
              onChangeText={(s) => setMessage(s.slice(0, 200))}
              placeholder={t('walletSend.messagePh') || 'Mensagem opcional (Parabéns!)'}
              placeholderTextColor={colors.textTertiary}
              maxLength={200}
              style={[
                styles.messageInput,
                {
                  color: colors.text,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#fff',
                  borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)',
                },
              ]}
            />

            {/* CTA */}
            <TouchableOpacity
              onPress={onSend}
              disabled={sending || !toEmail || amount < 1}
              style={[
                styles.sendBtn,
                {
                  backgroundColor: insufficient ? '#F59E0B' : '#A855F7',
                  opacity: (sending || !toEmail || amount < 1) ? 0.65 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('walletSend.cta') || 'Enviar diamantes'}
            >
              {sending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.sendBtnText}>
                  {insufficient
                    ? `${t('walletSend.topUpCta') || 'Comprar diamantes'}  ·  +${formatInt(amount - balance, language)} ◆`
                    : ((t('walletSend.cta') || 'Enviar {n} ◆').replace('{n}', formatInt(amount, language)))}
                </Text>
              )}
            </TouchableOpacity>

            <Text style={[styles.tos, { color: colors.textTertiary }]}>
              {t('walletSend.tos') || 'Diamantes não são reembolsáveis e não podem ser sacados.'}
            </Text>
          </View>
        </View>
      </Modal>

      {/* Top-up sheet — opens when balance is short or user taps "+ Comprar" */}
      <DiamondTopUpSheet
        visible={showTopUp}
        onClose={() => setShowTopUp(false)}
        onBalanceChange={(b) => { if (typeof b === 'number') setBalance(b); }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
    minHeight: 540,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 17, fontWeight: '700' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  receiverRow: { alignItems: 'center', paddingVertical: 10 },
  receiverName: { marginTop: 8, fontSize: 16, fontWeight: '700' },
  receiverEmail: { marginTop: 2, fontSize: 12 },
  sendDiamond: { position: 'absolute', top: 8, fontSize: 36 },
  balanceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 10, marginBottom: 12,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 12, backgroundColor: 'rgba(168,85,247,0.06)',
  },
  balanceLabel: { fontSize: 12 },
  balanceVal: { fontSize: 15, fontWeight: '800' },
  topUpInlineBtn: {
    marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, backgroundColor: '#A855F7',
  },
  topUpInlineText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  amountsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  amountChip: {
    flexGrow: 1, minWidth: '22%',
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  amountChipText: { fontSize: 15, fontWeight: '800' },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 4 },
  customLabel: { fontSize: 12, flex: 1 },
  customInput: {
    minWidth: 120,
    paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15, fontWeight: '700', textAlign: 'right',
  },
  customSuffix: { fontSize: 16, fontWeight: '800' },
  approxNote: { fontSize: 11, marginBottom: 10, textAlign: 'right' },
  messageInput: {
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14, marginBottom: 12, minHeight: 44,
  },
  sendBtn: {
    paddingVertical: 14, borderRadius: 14, alignItems: 'center',
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  tos: { fontSize: 10, marginTop: 10, textAlign: 'center', lineHeight: 14 },
});
