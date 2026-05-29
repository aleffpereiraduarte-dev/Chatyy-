/**
 * LiveShoppingOverlay — horizontal product card strip surfaced over the live
 * video. Up to 5 cards at once. Viewers tap a card → opens link_url via the
 * platform's external browser. Host can long-press → "Remove product" sheet
 * (handled by the parent — overlay only emits onRemove).
 *
 * Parent owns:
 *   products: [{ product_id, title, price_cents, image_url, link_url }]
 *   isHost: boolean
 *   onOpenProduct(product) → opens link_url
 *   onRemoveProduct(product) → host-only delete
 */

import React, { useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ScrollView, Linking, Platform,
} from 'react-native';
import { IconTag } from '../Icons';

function formatPrice(cents) {
  const v = (Number(cents) || 0) / 100;
  if (!v) return '';
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

export default function LiveShoppingOverlay({
  products = [],
  isHost = false,
  onOpenProduct,
  onRemoveProduct,
  i18n = {},
}) {
  const visible = Array.isArray(products) && products.length > 0;
  const t = {
    title: i18n.title || 'Produtos',
    tap: i18n.tap || 'Toque para abrir',
  };

  const openExternal = useCallback(async (url) => {
    if (!url) return;
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) await Linking.openURL(url);
    } catch (e) {
      console.warn('[LiveShoppingOverlay] openExternal failed', e?.message);
    }
  }, []);

  if (!visible) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Text style={styles.title}>{t.title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {products.slice(0, 5).map(p => (
          <TouchableOpacity
            key={p.product_id || p.link_url}
            onPress={() => {
              if (onOpenProduct) onOpenProduct(p);
              else openExternal(p.link_url);
            }}
            onLongPress={isHost && onRemoveProduct ? () => onRemoveProduct(p) : undefined}
            activeOpacity={0.85}
            style={styles.card}
            accessibilityRole="button"
            accessibilityLabel={p.title}
            accessibilityHint={t.tap}
          >
            <View style={styles.imageBox}>
              {p.image_url ? (
                <Image source={{ uri: p.image_url }} style={styles.image} resizeMode="cover" />
              ) : (
                <View style={[styles.image, styles.imageFallback]}>
                  <IconTag size={28} color="#9ca3af" />
                </View>
              )}
              {p.price_cents > 0 ? (
                <View style={styles.priceBadge}>
                  <Text style={styles.priceBadgeText}>{formatPrice(p.price_cents)}</Text>
                </View>
              ) : null}
            </View>
            <Text numberOfLines={2} style={styles.cardTitle}>{p.title}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0, right: 0,
    bottom: 90,
    paddingHorizontal: 8,
  },
  title: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11, fontWeight: '700',
    paddingHorizontal: 6,
    marginBottom: 4,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  row: { gap: 8, paddingHorizontal: 4 },
  card: {
    width: 96,
    backgroundColor: 'rgba(15,23,42,0.78)',
    borderRadius: 12,
    padding: 6,
    marginRight: 8,
  },
  imageBox: { position: 'relative' },
  image: {
    width: '100%', aspectRatio: 1, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  imageFallback: { alignItems: 'center', justifyContent: 'center' },
  imageFallbackText: { fontSize: 28 },
  priceBadge: {
    position: 'absolute', bottom: 4, right: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 6,
  },
  priceBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  cardTitle: {
    color: '#fff',
    fontSize: 11, fontWeight: '600',
    marginTop: 4, minHeight: 26,
  },
});
