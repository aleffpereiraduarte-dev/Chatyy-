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
 *  • [gift-premium 2026-10-16] prévia grande do presente tocado (flutua, driver
 *    nativo), recado opcional (chat), "Faltam N diamantes" + "Comprar
 *    diamantes" (só abre a loja — nada é cobrado aqui), celebração no envio.
 *
 * Props: visible, onClose, context ('live'|'post'|'chat'), targetId,
 *        recipientName?, keepOpen? (live: mantém aberto p/ combos),
 *        onSent?(result, gift, quantity)
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
  Animated, ScrollView, Easing, TextInput,
} from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconGiftBox } from '../Icons';
import { DiamondMono, celebrateGiftSent } from './giftFx';
import { isReduceMotionEnabled } from '../reducedMotion';
import LiveGiftGlyph from '../live/LiveGiftGlyph';
import { giftLabel, humanizeCount, QUANTITIES, COMBO_WINDOW_MS } from './giftCatalog';
import {
  getCachedGiftCatalog, loadGiftCatalog, refreshWallet, sendGift, useWallet, isMinorAccount, newClientId,
} from '../../services/diamonds';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragBackdrop } from '../ui/useDragToDismiss';

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
        <DiamondMono size={10} color="rgba(255,255,255,0.8)" />
        <Text style={styles.priceText}>{humanizeCount(g.diamonds_cost)}</Text>
      </View>
    </TouchableOpacity>
  );
});

const ND = Platform.OS !== 'web';
// Prévia grande do presente escolhido (entrada com mola + flutuar).
const Hero = memo(function Hero({ g, label, qty, t }) {
  const pop = useRef(new Animated.Value(0.6)).current;
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { pop.setValue(1); return undefined; }
    pop.setValue(0.6);
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 140, useNativeDriver: ND }).start();
    const lp = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: ND }),
      Animated.timing(float, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: ND }),
    ]));
    lp.start();
    return () => lp.stop();
  }, [g && g.sku, pop, float]);
  if (!g) {
    return (
      <View style={styles.hero}>
        <View style={styles.heroEmptyIcon}><IconGiftBox size={30} color="rgba(255,255,255,0.55)" /></View>
        <Text style={styles.heroHint}>{tr(t, 'gifts.pickOne', 'Escolha um presente')}</Text>
      </View>
    );
  }
  const ty = float.interpolate({ inputRange: [0, 1], outputRange: [3, -4] });
  return (
    <View style={styles.hero}>
      <View style={styles.heroHalo} />
      <Animated.View style={{ transform: [{ translateY: ty }, { scale: pop }] }}>
        <LiveGiftGlyph icon={g.icon} size={92} />
      </Animated.View>
      <Text style={styles.heroName} numberOfLines={1}>{label}{qty > 1 ? <Text style={styles.heroQty}>{`  ×${qty}`}</Text> : null}</Text>
      <View style={styles.heroPrice}>
        <DiamondMono size={12} color="#fff" />
        <Text style={styles.heroPriceText}>{humanizeCount(g.diamonds_cost * qty)}</Text>
      </View>
    </View>
  );
});

function GiftSheet({ visible, onClose, context, targetId, targetError = '', recipientName, keepOpen = false, onSent }) {
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
  const [note, setNote] = useState('');
  const showHero = !keepOpen;
  const showNote = context === 'chat';
  const comboRef = useRef({ id: '', sku: '', count: 0, timer: null });
  const ring = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const sendingRef = useRef(false);
  // [2026-10-22 presente-retry] Falha recuperável (rede/erro genérico) → "Tentar novamente" com o
  // MESMO client_id: o servidor (diamond_gift_send) responde idempotente e NUNCA cobra 2x.
  const lastFailRef = useRef(null);
  const [canRetry, setCanRetry] = useState(false);

  const minor = isMinorAccount();
  const disabled = wallet.loaded && (!wallet.enabled || !wallet.giftingEnabled);
  const balance = wallet.diamonds;

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setNotice(''); setNeedTopUp(false); setCombo(0); setNote('');
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

  const missingText = useCallback((n) => {
    const k = Math.max(1, Math.ceil(Number(n) || 0));
    return tr(t, 'gifts.missing', 'Diamantes insuficientes: faltam {n} para este presente.').replace('{n}', humanizeCount(k));
  }, [t]);

  const openShop = useCallback(() => {
    close();
    try { router.push('/diamond-shop'); } catch {}
  }, [close, router]);

  const send = useCallback(async () => {
    if (!selected || !targetId || sendingRef.current || minor || disabled) return; // [2026-10-17] alvo ainda resolvendo (perfil → chat_create)
    if (!canAfford) { setNeedTopUp(true); setNotice(missingText(total - (Number(balance) || 0))); haptic('error'); return; }
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
    const _args = { context, targetId, sku: selected.sku, quantity: qty, comboId: c.id, comboCount, note: showNote ? note : '', clientId: newClientId() };
    lastFailRef.current = null; setCanRetry(false);
    const res = await sendGift(_args);
    sendingRef.current = false;
    setSending(false);
    if (!res.ok && (res.code === 'network' || !['insufficient_diamonds', 'feature_disabled', 'minor_blocked', 'blocked', 'not_member', 'rate_limited'].includes(res.code))) {
      lastFailRef.current = { args: _args, selected, qty }; setCanRetry(true);
    }
    if (res.ok) {
      if (context === 'chat') celebrateGiftSent(); else haptic('success');
      onSent?.(res.data, selected, qty);
      setNote('');
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
      case 'insufficient_diamonds': {
        const need = Number(res.data && res.data.diamonds_required) || total;
        const have = Number(res.data && res.data.diamond_balance);
        setNeedTopUp(true); setNotice(missingText(need - (Number.isFinite(have) ? have : (Number(balance) || 0)))); break;
      }
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
  }, [selected, minor, disabled, canAfford, qty, context, targetId, onSent, keepOpen, close, resetCombo, ring, btnScale, t, note, showNote, total, balance, missingText]);

  const retrySend = useCallback(async () => {
    const f = lastFailRef.current;
    if (!f || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setNotice('');
    const res = await sendGift(f.args); // mesmo client_id → idempotente (nunca cobra 2x)
    sendingRef.current = false;
    setSending(false);
    if (res.ok) {
      lastFailRef.current = null; setCanRetry(false);
      if (context === 'chat') celebrateGiftSent(); else haptic('success');
      onSent?.(res.data, f.selected, f.qty);
      setNote('');
      if (!keepOpen) close();
      return;
    }
    haptic('error');
    if (res.code === 'network') setNotice(tr(t, 'gifts.network', 'Sem conexão. Nada foi cobrado.'));
    else if (res.code === 'insufficient_diamonds') { lastFailRef.current = null; setCanRetry(false); setNeedTopUp(true); setNotice(missingText(total - (Number(balance) || 0))); }
    else setNotice(tr(t, 'gifts.failed', 'Não foi possível enviar. Nada foi cobrado.'));
  }, [context, onSent, keepOpen, close, t, missingText, total, balance]);

  const grid = useMemo(() => catalog, [catalog]);
  // [2026-10-17 drag-dismiss] arrastar de qualquer ponto p/ baixo fecha (mesmo <Modal>, sem aninhar).
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: close, shouldConfirm: () => sending });
  if (!visible) return null;

  const title = recipientName
    ? tr(t, 'gifts.titleTo', 'Presente para {name}').replace('{name}', recipientName)
    : tr(t, 'gifts.title', 'Presentes');
  const negative = typeof balance === 'number' && balance < 0;
  const blockedText = targetError ? String(targetError) : minor
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
      <DragSheetRoot>
      <KeyboardSafeView style={styles.root}>
      <DragBackdrop drag={drag} color="rgba(0,0,0,0.4)" onPress={close} accessibilityLabel={tr(t, 'common.close', 'Fechar')} />
      <DragPanel drag={drag} style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={openShop} style={styles.balance} hitSlop={6} accessibilityRole="button"
            accessibilityLabel={`${tr(t, 'gifts.balance', 'Saldo')}: ${balance ?? ''}. ${tr(t, 'gifts.topUp', 'Recarregar')}`}>
            <DiamondMono size={13} color="#fff" />
            <Text style={[styles.balanceText, negative && styles.balanceNeg]}>{balance == null ? '—' : humanizeCount(balance)}</Text>
            <Text style={styles.topUp}>{tr(t, 'gifts.topUp', 'Recarregar')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={styles.close} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
            <IconX size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        {showHero ? <Hero g={selected} label={selected ? giftLabel(t, selected.icon, selected.label) : ''} qty={qty} t={t} /> : null}

        <DragScroll drag={drag}><ScrollView style={[styles.gridScroll, showHero && styles.gridScrollHero]} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
          {grid.map((g) => (
            <Cell key={g.sku} g={g} on={selected?.sku === g.sku} onPress={() => pick(g)} label={giftLabel(t, g.icon, g.label)} />
          ))}
        </ScrollView></DragScroll>

        {showNote && selected && !blockedText ? (
          <TextInput
            value={note}
            onChangeText={(v) => setNote(v.slice(0, 120))}
            placeholder={tr(t, 'gifts.notePlaceholder', 'Escreva um recado (opcional)')}
            placeholderTextColor="rgba(255,255,255,0.4)"
            style={styles.noteInput}
            maxLength={120}
            returnKeyType="done"
            blurOnSubmit
            accessibilityLabel={tr(t, 'gifts.notePlaceholder', 'Escreva um recado (opcional)')}
          />
        ) : null}

        {blockedText ? <Text style={styles.notice}>{blockedText}</Text> : null}
        {!blockedText && notice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}
        {!blockedText && notice && canRetry && !sending ? (
          <TouchableOpacity onPress={retrySend} accessibilityRole="button" style={styles.retryBtn} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
            <Text style={styles.retryText}>{tr(t, 'chat.retry', 'Tentar novamente')}</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.qtyRow}>
          {QUANTITIES.map((q) => {
            const on = qty === q;
            return (
              <TouchableOpacity key={q} onPress={() => { haptic('select'); setQty(q); resetCombo(); }}
                style={[styles.qtyChip, on && styles.qtyChipOn]} hitSlop={6} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`x${q}`}>
                <Text style={[styles.qtyText, on && styles.qtyTextOn]}>{`x${q}`}</Text>
              </TouchableOpacity>
            );
          })}
          <View style={{ flex: 1 }} />
          {selected ? (
            <View style={styles.totalPill}>
              <DiamondMono size={12} color="#fff" />
              <Text style={styles.totalText}>{humanizeCount(total)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.footer}>
          {needTopUp || negative ? (
            <TouchableOpacity onPress={openShop} style={styles.sendBtn} accessibilityRole="button">
              <DiamondMono size={15} color="#000" />
              <Text style={styles.sendText}>{tr(t, 'gifts.buyDiamonds', 'Comprar diamantes')}</Text>
            </TouchableOpacity>
          ) : (
            <Animated.View style={{ transform: [{ scale: btnScale }], flex: 1, height: 50 }}>
              <TouchableOpacity
                onPress={send}
                disabled={!selected || !!blockedText || !targetId}
                style={[styles.sendBtn, (!selected || !!blockedText || !targetId) && styles.sendBtnOff]}
                accessibilityRole="button"
                accessibilityLabel={sendLabel}
              >
                {combo > 0 ? (
                  <Animated.View pointerEvents="none" style={[styles.comboRing, {
                    width: ring.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                  }]} />
                ) : null}
                {sending && !combo ? <ActivityIndicator color="#000" /> : (
                  <>
                    <Text style={styles.sendText}>{sendLabel}</Text>
                    {selected && !combo ? (
                      <View style={styles.sendCost}>
                        <DiamondMono size={13} color="#000" />
                        <Text style={styles.sendCostText}>{humanizeCount(total)}</Text>
                      </View>
                    ) : null}
                  </>
                )}
              </TouchableOpacity>
            </Animated.View>
          )}
        </View>
      </DragPanel>
      </KeyboardSafeView>
      </DragSheetRoot>
    </Modal>
  );
}

export default memo(GiftSheet);

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' }, // [gift-premium] folha nunca passa da tela: a grade encolhe
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '94%',
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
  gridScroll: { maxHeight: 330, flexGrow: 0, flexShrink: 1 },
  gridScrollHero: { maxHeight: 212 },
  hero: { height: 158, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  heroHalo: { position: 'absolute', top: 6, width: 112, height: 112, borderRadius: 56, backgroundColor: 'rgba(255,255,255,0.06)' },
  heroName: { color: '#fff', fontSize: 17, fontWeight: '800', marginTop: 4, letterSpacing: -0.2 },
  heroQty: { fontSize: 15, fontWeight: '900' },
  heroPrice: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  heroPriceText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '800' },
  heroEmptyIcon: {
    width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderStyle: 'dashed',
  },
  heroHint: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600', marginTop: 10 },
  noteInput: {
    marginTop: 12, height: 42, borderRadius: 21, paddingHorizontal: 16, color: '#fff', fontSize: 14.5,
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  sendCost: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 10, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: 'rgba(0,0,0,0.18)' },
  sendCostText: { color: '#000', fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] },
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
  retryBtn: { alignSelf: 'center', marginTop: 8, paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' },
  retryText: { color: '#FFFFFF', fontSize: 13.5, fontWeight: '700' },
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
  footer: { flexDirection: 'row', marginTop: 12, minHeight: 50, flexShrink: 0 }, // nunca achata o botão
  sendBtn: {
    flex: 1, height: 50, borderRadius: 25, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    flexDirection: 'row', gap: 8,
  },
  sendBtnOff: { opacity: 0.35 },
  comboRing: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.12)' },
  sendText: { color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
});
