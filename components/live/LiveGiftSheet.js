/**
 * LiveGiftSheet — catálogo de presentes P&B premium (TikTok-like).
 *
 *  • Grade 3 colunas: arte SVG (LiveGiftGlyph), nome, preço em diamantes.
 *  • Saldo de diamantes no topo + atalho "Recarregar" (/diamond-shop).
 *  • Toque seleciona; "Enviar" manda; toques seguidos no mesmo presente viram
 *    combo ("Enviar x3") — cada toque é 1 envio (o servidor debita e difunde
 *    live_gift; o banner com combo aparece pra todo mundo).
 *  • 402 → saldo insuficiente (CTA recarregar); 410 → presentes desligados.
 *
 * Só monta quando LIVE_GIFTS_ENABLED (ver liveEngageConfig).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, Pressable, StyleSheet, Platform, ActivityIndicator, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconDiamond } from '../Icons';
import LiveGiftGlyph from './LiveGiftGlyph';
import * as engApi from './liveEngageApi';
import { LOCAL_GIFT_CATALOG, giftLabel, humanizeCount } from './liveEngageConfig';
import { useEngageSelector, selSheet } from './liveEngageStore';

function normalizeCatalog(list) {
  if (!Array.isArray(list) || !list.length) return LOCAL_GIFT_CATALOG;
  return list
    .filter(g => g && g.sku)
    .map(g => ({ sku: g.sku, icon: g.icon || String(g.sku).replace(/^gift_/, ''), label: g.label || g.sku, diamonds_cost: Number(g.diamonds_cost) || 0 }));
}

function LiveGiftSheet({ engage }) {
  const { t } = useLanguage();
  const router = useRouter();
  const sheet = useEngageSelector(engage, selSheet);
  const visible = sheet === 'gift';
  const [catalog, setCatalog] = useState(LOCAL_GIFT_CATALOG);
  const [balance, setBalance] = useState(null);
  const [selected, setSelected] = useState(null);
  const [combo, setCombo] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [needTopUp, setNeedTopUp] = useState(false);
  const comboTimer = useRef(null);
  const btnScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setNotice(''); setNeedTopUp(false); setCombo(0);
    engApi.giftCatalog().then((r) => {
      const list = r?.data?.gifts || r?.gifts;
      if (alive) setCatalog(normalizeCatalog(list));
    }).catch(() => {});
    engApi.balance().then((r) => {
      const b = r?.data?.diamond_balance ?? r?.diamond_balance;
      if (alive && typeof b === 'number') setBalance(b);
    }).catch(() => {});
    return () => { alive = false; };
  }, [visible]);

  useEffect(() => () => { if (comboTimer.current) clearTimeout(comboTimer.current); }, []);

  const close = useCallback(() => engage?.closeSheet(), [engage]);

  const send = useCallback(async () => {
    if (!selected || sending) return;
    Animated.sequence([
      Animated.timing(btnScale, { toValue: 0.92, duration: 70, useNativeDriver: true }),
      Animated.spring(btnScale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
    setSending(true);
    setNotice('');
    try {
      const r = await engage.sendGift(selected.sku);
      if (r?.success) {
        const nb = r?.data?.diamond_balance ?? r?.data?.new_balance;
        if (typeof nb === 'number') setBalance(nb);
        else setBalance(b => (typeof b === 'number' ? Math.max(0, b - selected.diamonds_cost) : b));
        setCombo(c => c + 1);
        if (comboTimer.current) clearTimeout(comboTimer.current);
        comboTimer.current = setTimeout(() => setCombo(0), 3500);
      } else if (r?.data?.code === 'insufficient_diamonds' || /insufficient/i.test(String(r?.message || ''))) {
        setNeedTopUp(true);
        setNotice(t('liveEng.giftNoBalance'));
      } else if (r?.data?.feature_disabled) {
        setNotice(t('liveEng.giftsUnavailable'));
      } else {
        setNotice(t('liveEng.giftFailed'));
      }
    } catch {
      setNotice(t('liveEng.giftFailed'));
    } finally {
      setSending(false);
    }
  }, [selected, sending, engage, t, btnScale]);

  const openShop = useCallback(() => {
    close();
    try { router.push('/diamond-shop'); } catch {}
  }, [close, router]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={t('common.close')} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title}>{t('liveEng.giftsTitle')}</Text>
          <TouchableOpacity onPress={openShop} style={styles.balance} accessibilityRole="button" accessibilityLabel={t('liveEng.topUp')}>
            <IconDiamond size={14} color="#fff" />
            <Text style={styles.balanceText}>{balance == null ? '—' : humanizeCount(balance)}</Text>
            <Text style={styles.topUp}>{t('liveEng.topUp')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={styles.close} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={styles.grid}>
          {catalog.map((g) => {
            const on = selected?.sku === g.sku;
            return (
              <TouchableOpacity
                key={g.sku}
                onPress={() => { setSelected(g); setCombo(0); setNotice(''); setNeedTopUp(false); }}
                style={[styles.cell, on && styles.cellOn]}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${giftLabel(t, g.icon, g.label)} ${g.diamonds_cost}`}
              >
                <LiveGiftGlyph icon={g.icon} size={46} />
                <Text style={styles.cellName} numberOfLines={1}>{giftLabel(t, g.icon, g.label)}</Text>
                <View style={styles.price}>
                  <IconDiamond size={10} color="rgba(255,255,255,0.8)" />
                  <Text style={styles.priceText}>{humanizeCount(g.diamonds_cost)}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <View style={styles.footer}>
          {needTopUp ? (
            <TouchableOpacity onPress={openShop} style={styles.sendBtn} accessibilityRole="button">
              <Text style={styles.sendText}>{t('liveEng.topUp')}</Text>
            </TouchableOpacity>
          ) : (
            <Animated.View style={{ transform: [{ scale: btnScale }], flex: 1 }}>
              <TouchableOpacity
                onPress={send}
                disabled={!selected || sending}
                style={[styles.sendBtn, (!selected) && styles.sendBtnOff]}
                accessibilityRole="button"
                accessibilityLabel={t('liveEng.giftSend')}
              >
                {sending && !combo ? <ActivityIndicator color="#000" /> : (
                  <Text style={styles.sendText}>
                    {combo > 0 ? t('liveEng.giftSendCombo').replace('{n}', String(combo + 1)) : t('liveEng.giftSend')}
                  </Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default memo(LiveGiftSheet);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: '#0b0b0b',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14, paddingBottom: Platform.OS === 'ios' ? 34 : 18, paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  balance: {
    flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10,
    borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  balanceText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  topUp: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', marginLeft: 2 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  cell: {
    width: '31.5%', alignItems: 'center', paddingVertical: 12, gap: 5,
    borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  cellOn: { borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.1)' },
  cellName: { color: '#fff', fontSize: 12, fontWeight: '700' },
  price: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  priceText: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '700' },
  notice: { color: 'rgba(255,255,255,0.8)', fontSize: 12, textAlign: 'center', marginTop: 10 },
  footer: { flexDirection: 'row', marginTop: 12 },
  sendBtn: { flex: 1, height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { opacity: 0.35 },
  sendText: { color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
});
