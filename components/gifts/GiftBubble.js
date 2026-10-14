/**
 * GiftBubble — bolha da mensagem type 'gift' no chat 1:1.
 * content (JSON, gravado pelo servidor no diamond_gift_send context 'chat'):
 *   { v:1, gift_id, gift_sku, icon, tier, quantity, unit_diamonds, diamonds,
 *     label, preview, preview_en, preview_es }
 * P&B: arte SVG do presente + nome ×N; o diamante é a única cor. Nunca mostra
 * o JSON cru — conteúdo ilegível vira "Presente".
 */
import { memo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { IconDiamond } from '../Icons';
import LiveGiftGlyph from '../live/LiveGiftGlyph';
import { parseGiftContent, giftMeta, giftLabel, humanizeCount } from './giftCatalog';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

function GiftBubble({ content, isOwn, t, textColor, subColor, animate = false }) {
  const j = parseGiftContent(content) || {};
  const meta = giftMeta(j.gift_sku || '');
  const icon = j.icon || meta.icon;
  const qty = Math.max(1, Number(j.quantity) || 1);
  const diamonds = Number(j.diamonds) || (Number(j.unit_diamonds) || meta.diamonds) * qty;
  const label = giftLabel(t, icon, j.label || meta.label);
  const pop = useRef(new Animated.Value(animate ? 0.6 : 1)).current;
  useEffect(() => {
    if (!animate) return;
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }).start();
  }, [animate, pop]);

  const head = isOwn ? tr(t, 'gifts.youSent', 'Você enviou um presente') : tr(t, 'gifts.youReceived', 'Enviou um presente para você');
  return (
    <View style={styles.wrap} accessibilityLabel={`${head}: ${label}${qty > 1 ? ' x' + qty : ''}, ${diamonds}`}>
      <Animated.View style={[styles.art, { transform: [{ scale: pop }] }]}>
        <LiveGiftGlyph icon={icon} size={72} />
      </Animated.View>
      <Text style={[styles.head, { color: subColor }]} numberOfLines={1}>{head}</Text>
      <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>
        {label}{qty > 1 ? <Text style={styles.qty}>{`  ×${qty}`}</Text> : null}
      </Text>
      <View style={styles.cost}>
        <IconDiamond size={12} />
        <Text style={[styles.costText, { color: subColor }]}>{humanizeCount(diamonds)}</Text>
      </View>
    </View>
  );
}

export default memo(GiftBubble);

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, minWidth: 160 },
  art: {
    width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0b0b0b', marginBottom: 8,
  },
  head: { fontSize: 12, fontWeight: '600' },
  name: { fontSize: 16, fontWeight: '800', marginTop: 2 },
  qty: { fontSize: 15, fontWeight: '900' },
  cost: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  costText: { fontSize: 12, fontWeight: '700' },
});
