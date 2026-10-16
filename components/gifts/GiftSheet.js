/**
 * GiftSheet — painel de presentes P&B premium (TikTok-like), único para
 * live, reels/posts e chat 1:1.
 *
 *  • Grade 4 colunas com arte SVG (LiveGiftGlyph), nome e custo em diamantes
 *    (o diamante é a única cor da tela).
 *  • Saldo no topo + "Recarregar" (/diamond-shop). Saldo pode ser negativo
 *    (estorno de compra) → envio bloqueado com aviso.
 *  • Quantidade x1 / x5 / x10 / x99 (custo total no botão).
 *  • Combo: toques seguidos no MESMO presente dentro de 3s compartilham
 *    combo_id e somam combo_count (o banner de quem recebe sobe o "xN").
 *  • Cada envio leva client_id (idempotente no servidor — retry não cobra 2x).
 *  • 402 → saldo insuficiente (CTA recarregar); 410 → presentes desligados;
 *    menor de idade (parental) → bloqueado.
 *
 * Props: visible, onClose, context ('live'|'post'|'chat'), targetId,
 *        recipientName?, keepOpen? (live: mantém aberto p/ combos),
 *        onSent?(result, gift, quantity)
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, Pressable, StyleSheet, Platform, ActivityIndicator,
  Animated, ScrollView, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconDiamond } from '../Icons';
import LiveGiftGlyph from '../live/LiveGiftGlyph';
import { giftLabel, humanizeCount, QUANTITIES, COMBO_WINDOW_MS } from './giftCatalog';
import {
  getCachedGiftCatalog, loadGiftCatalog, refreshWallet, sendGift, useWallet, isMinorAccount, newClientId,
} from '../../services/diamonds';

function haptic(kind) {
  try {
    const H = require('../../services/haptics').HapticsCompat;
    if (kind === 'success') H.notificationAsync(H.NotificationFeedbackType.Success);
    else if (kind === 'error') H.notificationAsync(H.NotificationFeedbackType.Error);
    else H.selectionAsync();
  } catch {}
}

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

const Cell = memo(function Cell({ g, on, onPress, label }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: on ? 1.06 : 1, friction: 6, tension: 180, useNativeDriver: true }).start();
  }, [on, scale]);
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.cell, on && styles.cellOn]}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${label}, ${g.diamonds_cost}`}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <LiveGiftGlyph icon={g.icon} size={44} />
      </Animated.View>
      <Text style={styles.cellName} numberOfLines={1}>{label}</Text>
      <View style={styles.price}>
        <IconDiamond size={10} />
        <Text style={styles.priceText}>{humanizeCount(g.diamonds_cost)}</Text>
      </View>
    </TouchableOpacity>
  );
});

function GiftSheet({ visible, onClose, context, targetId, recipientName, keepOpen = false, onSent }) {
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const [catalog, setCatalog] = useState(getCachedGiftCatalog());
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [combo, setCombo] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [needTopUp, setNeedTopUp] = useState(false);
  const comboRef = useRef({ id: '', sku: '', count: 0, timer: null });
  const ring = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const sendingRef = useRef(false);

  const minor = isMinorAccount();
  const disabled = wallet.loaded && (!wallet.enabled || !wallet.giftingEnabled);
  const balance = wallet.diamonds;

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setNotice(''); setNeedTopUp(false); setCombo(0);
    loadGiftCatalog().then((c) => { if (alive) setCatalog(c); });
    refreshWallet();
    return () => { alive = false; };
  }, [visible]);

  useEffect(() => () => { if (comboRef.current.timer) clearTimeout(comboRef.current.timer); }, []);

  const resetCombo = useCallback(() => {
    const c = comboRef.current;
    if (c.timer) clearTimeout(c.timer);
    comboRef.current = { id: '', sku: '', count: 0, timer: null };
    setCombo(0);
    ring.stopAnimation(); ring.setValue(0);
  }, [ring]);

  const pick = useCallback((g) => {
    haptic('select');
    setSelected(g); setNotice(''); setNeedTopUp(false);
    if (comboRef.current.sku !== g.sku) resetCombo();
  }, [resetCombo]);

  const close = useCallback(() => { resetCombo(); onClose?.(); }, [onClose, resetCombo]);

  const total = selected ? selected.diamonds_cost * qty : 0;
  const canAfford = typeof balance === 'number' ? balance >= total : true;

  const openShop = useCallback(() => {
    close();
    try { router.push('/diamond-shop'); } catch {}
  }, [close, router]);

  const send = useCallback(async () => {
    if (!selected || sendingRef.current || minor || disabled) return;
    if (!canAfford) { setNeedTopUp(true); setNotice(tr(t, 'gifts.noBalance', 'Diamantes insuficientes.')); haptic('error'); return; }
    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.92, duration: 70, useNativeDriver: true }),
      Animated.spring(btnScale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
    const c = comboRef.current;
    if (c.sku !== selected.sku || !c.id) { c.id = newClientId(); c.sku = selected.sku; c.count = 0; }
    c.count += qty;
    const comboCount = c.count;
    sendingRef.current = true;
    setSending(true);
    setNotice('');
    const res = await sendGift({
      context, targetId, sku: selected.sku, quantity: qty, comboId: c.id, comboCount,
    });
    sendingRef.current = false;
    setSending(false);
    if (res.ok) {
      haptic('success');
      onSent?.(res.data, selected, qty);
      if (!keepOpen) { close(); return; }
      setCombo(comboCount);
      if (c.timer) clearTimeout(c.timer);
      ring.stopAnimation(); ring.setValue(1);
      Animated.timing(ring, { toValue: 0, duration: COMBO_WINDOW_MS, easing: Easing.linear, useNativeDriver: false }).start();
      c.timer = setTimeout(() => resetCombo(), COMBO_WINDOW_MS);
      return;
    }
    c.count -= qty;
    haptic('error');
    switch (res.code) {
      case 'insufficient_diamonds':
        setNeedTopUp(true); setNotice(tr(t, 'gifts.noBalance', 'Diamantes insuficientes.')); break;
      case 'feature_disabled':
        setNotice(tr(t, 'gifts.unavailable', 'Presentes indisponíveis no momento.')); break;
      case 'minor_blocked':
        setNotice(tr(t, 'gifts.minorBlocked', 'Presentes não estão disponíveis para contas supervisionadas.')); break;
      case 'blocked':
      case 'not_member':
        setNotice(tr(t, 'gifts.cantSendHere', 'Não é possível enviar presente aqui.')); break;
      case 'rate_limited':
        setNotice(tr(t, 'gifts.slowDown', 'Calma! Muitos presentes seguidos. Tente em instantes.')); break;
      case 'network':
        setNotice(tr(t, 'gifts.network', 'Sem conexão. Nada foi cobrado.')); break;
      default:
        setNotice(tr(t, 'gifts.failed', 'Não foi possível enviar. Nada foi cobrado.'));
    }
  }, [selected, minor, disabled, canAfford, qty, context, targetId, onSent, keepOpen, close, resetCombo, ring, btnScale, t]);

  const grid = useMemo(() => catalog, [catalog]);
  if (!visible) return null;

  const title = recipientName
    ? tr(t, 'gifts.titleTo', 'Presente para {name}').replace('{name}', recipientName)
    : tr(t, 'gifts.title', 'Presentes');
  const negative = typeof balance === 'number' && balance < 0;
  const blockedText = minor
    ? tr(t, 'gifts.minorBlocked', 'Presentes não estão disponíveis para contas supervisionadas.')
    : disabled
      ? tr(t, 'gifts.unavailable', 'Presentes indisponíveis no momento.')
      : negative
        ? tr(t, 'gifts.negativeBalance', 'Seu saldo está negativo por causa de um reembolso. Recarregue para voltar a enviar.')
        : '';

  const sendLabel = combo > 0
    ? tr(t, 'gifts.sendCombo', 'Combo x{n}').replace('{n}', String(combo))
    : tr(t, 'gifts.send', 'Enviar');

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={openShop} style={styles.balance} accessibilityRole="button"
            accessibilityLabel={`${tr(t, 'gifts.balance', 'Saldo')}: ${balance ?? ''}. ${tr(t, 'gifts.topUp', 'Recarregar')}`}>
            <IconDiamond size={14} />
            <Text style={[styles.balanceText, negative && styles.balanceNeg]}>{balance == null ? '—' : humanizeCount(balance)}</Text>
            <Text style={styles.topUp}>{tr(t, 'gifts.topUp', 'Recarregar')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={styles.close} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
            <IconX size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
          {grid.map((g) => (
            <Cell key={g.sku} g={g} on={selected?.sku === g.sku} onPress={() => pick(g)} label={giftLabel(t, g.icon, g.label)} />
          ))}
        </ScrollView>

        {blockedText ? <Text style={styles.notice}>{blockedText}</Text> : null}
        {!blockedText && notice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}

        <View style={styles.qtyRow}>
          {QUANTITIES.map((q) => {
            const on = qty === q;
            return (
              <TouchableOpacity key={q} onPress={() => { haptic('select'); setQty(q); resetCombo(); }}
                style={[styles.qtyChip, on && styles.qtyChipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`x${q}`}>
                <Text style={[styles.qtyText, on && styles.qtyTextOn]}>{`x${q}`}</Text>
              </TouchableOpacity>
            );
          })}
          <View style={{ flex: 1 }} />
          {selected ? (
            <View style={styles.totalPill}>
              <IconDiamond size={12} />
              <Text style={styles.totalText}>{humanizeCount(total)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.footer}>
          {needTopUp || negative ? (
            <TouchableOpacity onPress={openShop} style={styles.sendBtn} accessibilityRole="button">
              <Text style={styles.sendText}>{tr(t, 'gifts.topUp', 'Recarregar')}</Text>
            </TouchableOpacity>
          ) : (
            <Animated.View style={{ transform: [{ scale: btnScale }], flex: 1 }}>
              <TouchableOpacity
                onPress={send}
                disabled={!selected || !!blockedText}
                style={[styles.sendBtn, (!selected || !!blockedText) && styles.sendBtnOff]}
                accessibilityRole="button"
                accessibilityLabel={sendLabel}
              >
                {combo > 0 ? (
                  <Animated.View pointerEvents="none" style={[styles.comboRing, {
                    width: ring.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                  }]} />
                ) : null}
                {sending && !combo ? <ActivityIndicator color="#000" /> : (
                  <Text style={styles.sendText}>{sendLabel}</Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default memo(GiftSheet);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: '#0b0b0b',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14, paddingTop: 8,
    ...(Platform.OS === 'web' ? { maxWidth: 560, width: '100%', alignSelf: 'center' } : null),
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  balance: {
    flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10,
    borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  balanceText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  balanceNeg: { color: '#FF6B6B' },
  topUp: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', marginLeft: 2 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  gridScroll: { maxHeight: 330 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  cell: {
    width: '23.5%', marginHorizontal: '0.75%', alignItems: 'center', paddingVertical: 10, gap: 4,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  cellOn: { borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.1)' },
  cellName: { color: '#fff', fontSize: 11.5, fontWeight: '700', maxWidth: '92%' },
  price: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  priceText: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '700' },
  notice: { color: 'rgba(255,255,255,0.82)', fontSize: 12.5, textAlign: 'center', marginTop: 10, lineHeight: 17 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  qtyChip: {
    minWidth: 44, height: 32, borderRadius: 16, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
  },
  qtyChipOn: { backgroundColor: '#fff', borderColor: '#fff' },
  qtyText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '800' },
  qtyTextOn: { color: '#000' },
  totalPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  totalText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  footer: { flexDirection: 'row', marginTop: 12 },
  sendBtn: {
    flex: 1, height: 50, borderRadius: 25, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  sendBtnOff: { opacity: 0.35 },
  comboRing: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.12)' },
  sendText: { color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
});
