// LivePaidGiftSheet — bottom sheet with 6-tier paid gift catalog + diamond
// balance + "Buy diamonds" CTA. Distinct from LiveGiftPicker (the free,
// virtual-gift overlay) because monetization shipping requires a separate
// SKU set and an explicit IAP path.
//
// Pricing rail (must match server live_gift_catalog + ASC IAP SKUs):
//   $0.99 (100 diamonds)  → gift_rose
//   $2.99 (300)           → gift_star
//   $9.99 (1,000)         → gift_crown
//   $19.99 (2,000)        → gift_rocket
//   $49.99 (5,000)        → gift_galaxy
//   $99.99 (10,000)       → gift_legend
//
// Diamond top-up SKUs:
//   com.onemundo.mail.diamonds_100  / 300 / 1000 / 2000 / 5000 / 10000
//
// IAP integration is a TODO in this scaffold: the user said "data model +
// UI now". The "Buy" button currently fires a no-op + toast; the real IAP
// call lands when expo-in-app-purchases is wired into the wallet path.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, FlatList, Alert, Platform,
} from 'react-native';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconX } from './Icons';
import DiamondTopUpSheet from './DiamondTopUpSheet';

// Fallback static catalog so the sheet renders even if the network call
// fails on first paint. Backend response always wins when it lands.
const FALLBACK_GIFTS = [
  { sku: 'gift_rose',   label: 'Rose',   icon: 'rose',   diamonds_cost: 100,    usd_cents: 99 },
  { sku: 'gift_star',   label: 'Star',   icon: 'star',   diamonds_cost: 300,    usd_cents: 299 },
  { sku: 'gift_crown',  label: 'Crown',  icon: 'crown',  diamonds_cost: 1000,   usd_cents: 999 },
  { sku: 'gift_rocket', label: 'Rocket', icon: 'rocket', diamonds_cost: 2000,   usd_cents: 1999 },
  { sku: 'gift_galaxy', label: 'Galaxy', icon: 'galaxy', diamonds_cost: 5000,   usd_cents: 4999 },
  { sku: 'gift_legend', label: 'Legend', icon: 'legend', diamonds_cost: 10000,  usd_cents: 9999 },
];

const FALLBACK_PACKS = [
  { sku: 'com.onemundo.mail.diamonds_100',   diamonds: 100,   price_cents: 99 },
  { sku: 'com.onemundo.mail.diamonds_300',   diamonds: 300,   price_cents: 299 },
  { sku: 'com.onemundo.mail.diamonds_1000',  diamonds: 1000,  price_cents: 999 },
  { sku: 'com.onemundo.mail.diamonds_2000',  diamonds: 2000,  price_cents: 1999 },
  { sku: 'com.onemundo.mail.diamonds_5000',  diamonds: 5000,  price_cents: 4999 },
  { sku: 'com.onemundo.mail.diamonds_10000', diamonds: 10000, price_cents: 9999 },
];

// Map gift icon key → emoji-free SVG fallback (text glyph until we ship real
// SVGs to /assets). The icons are intentionally bold + abstract so they read
// at the 56px tile size used in the grid.
const ICON_GLYPHS = {
  rose: 'R', star: 'S', crown: 'C', rocket: 'L', galaxy: 'G', legend: 'L*',
};

function formatPriceCents(cents) {
  const v = (Number(cents) || 0) / 100;
  return `$${v.toFixed(2)}`;
}

export default function LivePaidGiftSheet({ visible, onClose, sessionId, hostEmail }) {
  // DIAMANTE DESLIGADO — catálogo de presentes pagos + comprar diamantes removido.
  // Backend retorna 410; o sheet vira no-op (nunca renderiza / nunca abre).
  return null;
  // eslint-disable-next-line no-unreachable
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [gifts, setGifts] = useState(FALLBACK_GIFTS);
  const [packs, setPacks] = useState(FALLBACK_PACKS);
  const [balance, setBalance] = useState(0);
  const [sending, setSending] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  // Load catalog + balance whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const c = await api.liveGiftCatalog();
        if (c?.success && c.data) {
          if (Array.isArray(c.data.gifts) && c.data.gifts.length) setGifts(c.data.gifts);
          if (Array.isArray(c.data.diamond_packs) && c.data.diamond_packs.length) setPacks(c.data.diamond_packs);
        }
      } catch (e) { /* keep fallback */ }
      try {
        const b = await api.walletBalance();
        if (b?.success && b.data) setBalance(Number(b.data.diamond_balance) || 0);
      } catch (e) { /* keep zero */ }
    })();
  }, [visible]);

  const onSend = useCallback(async (gift) => {
    if (!sessionId || !gift?.sku || sending) return;
    if (balance < (gift.diamonds_cost || 0)) {
      setTopupOpen(true);
      return;
    }
    setSending(true);
    try {
      const res = await api.liveGiftSend(sessionId, gift.sku);
      if (res?.success) {
        if (res.data?.diamond_balance != null) setBalance(Number(res.data.diamond_balance));
        // Close sheet — gift animation will fan-out via WS `live_gift`.
        onClose && onClose();
      } else if (res?.data?.code === 'insufficient_diamonds') {
        setBalance(Number(res.data.diamond_balance) || 0);
        setTopupOpen(true);
      } else {
        Alert.alert(t('common.error') || 'Erro', res?.message || 'Send failed');
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }, [balance, onClose, sending, sessionId, t]);

  const onTopupBalanceChange = useCallback((b) => {
    if (typeof b === 'number') setBalance(b);
  }, []);

  const renderGift = ({ item }) => {
    const affordable = balance >= (item.diamonds_cost || 0);
    return (
      <TouchableOpacity
        onPress={() => onSend(item)}
        style={[styles.giftTile, !affordable && { opacity: 0.6 }]}
        activeOpacity={0.85}
        disabled={sending}
        accessibilityRole="button"
        accessibilityLabel={`${item.label} ${item.diamonds_cost} diamonds`}
      >
        <View style={styles.giftIconBox}>
          <Text style={styles.giftIconText}>{ICON_GLYPHS[item.icon] || '★'}</Text>
        </View>
        <Text style={styles.giftLabel} numberOfLines={1}>{item.label}</Text>
        <Text style={styles.giftPrice}>{item.diamonds_cost} ◆</Text>
        <Text style={styles.giftUsd}>{formatPriceCents(item.usd_cents)}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}>
          {/* Header */}
          <View style={styles.head}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('live.giftSheetTitle') || 'Mande um presente'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
              <IconX size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Balance row */}
          <View style={styles.balanceRow}>
            <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
              {t('live.diamondBalance') || 'Saldo'}:
            </Text>
            <Text style={[styles.balanceVal, { color: colors.text }]}>{balance} ◆</Text>
            <TouchableOpacity onPress={() => setTopupOpen(true)} style={styles.buyBtn} accessibilityRole="button">
              <Text style={styles.buyBtnText}>{t('live.buyDiamonds') || 'Comprar'}</Text>
            </TouchableOpacity>
          </View>

          {/* Gift grid — 3 cols × 2 rows */}
          <FlatList
            data={gifts}
            renderItem={renderGift}
            keyExtractor={(g) => g.sku}
            numColumns={3}
            columnWrapperStyle={{ gap: 10, justifyContent: 'space-between' }}
            contentContainerStyle={styles.gridPad}
            scrollEnabled={false}
          />

          {sending ? <View style={styles.sendingOverlay}><ActivityIndicator color="#fff" /></View> : null}
        </View>

        {/* Top-up sheet — real StoreKit IAP via DiamondTopUpSheet. */}
        <DiamondTopUpSheet
          visible={topupOpen}
          onClose={() => setTopupOpen(false)}
          onBalanceChange={onTopupBalanceChange}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30,
    minHeight: 360,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '700' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  balanceLabel: { fontSize: 13 },
  balanceVal: { fontSize: 15, fontWeight: '800' },
  buyBtn: {
    marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, backgroundColor: '#A855F7',
  },
  buyBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  gridPad: { paddingBottom: 4, gap: 10 },
  giftTile: {
    flex: 1, aspectRatio: 0.85, marginBottom: 10,
    borderRadius: 14, padding: 10,
    backgroundColor: 'rgba(168,85,247,0.08)',
    borderWidth: 1, borderColor: 'rgba(168,85,247,0.18)',
    alignItems: 'center',
  },
  giftIconBox: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#A855F7',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 6,
  },
  giftIconText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  giftLabel: { color: '#fff', fontSize: 12, fontWeight: '700' },
  giftPrice: { color: '#FBBF24', fontSize: 13, fontWeight: '800', marginTop: 2 },
  giftUsd: { color: 'rgba(255,255,255,0.55)', fontSize: 10, marginTop: 1 },

  sendingOverlay: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },

  packRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.04)',
    marginBottom: 8,
  },
  packDiamonds: { fontSize: 15, fontWeight: '800' },
  packPrice: { fontSize: 15, fontWeight: '700' },
});
