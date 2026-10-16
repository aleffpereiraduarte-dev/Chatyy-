/**
 * GiftBubble — bolha da mensagem type 'gift' no chat 1:1.
 * content (JSON, gravado pelo servidor no diamond_gift_send context 'chat'):
 *   { v:1, gift_id, gift_sku, icon, tier, quantity, unit_diamonds, diamonds,
 *     label, preview, preview_en, preview_es, note?, from_name?, to_name? }
 * [gift-premium 2026-10-16] P&B premium: palco escuro com a arte do presente
 * em destaque (entrada com mola + flutuar + brilhos piscando, driver nativo,
 * respeita "Reduzir movimento"), "Você enviou ◇50 a Fulano" com o diamante
 * monocromático (sem emoji), recado opcional do remetente e "Agradecer" para
 * quem recebe. Nunca mostra o JSON cru — conteúdo ilegível vira "Presente".
 */
import { memo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, TouchableOpacity, Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import LiveGiftGlyph from '../live/LiveGiftGlyph';
import { parseGiftContent, giftMeta, giftLabel, humanizeCount } from './giftCatalog';
import { DiamondMono, giftHeadParts } from './giftFx';
import { isReduceMotionEnabled } from '../reducedMotion';

const ND = Platform.OS !== 'web';
function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

function Sparkle({ size = 10, color = '#ffffff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 1.5c.7 5.6 4.9 9.8 10.5 10.5-5.6.7-9.8 4.9-10.5 10.5C11.3 16.9 7.1 12.7 1.5 12 7.1 11.3 11.3 7.1 12 1.5Z" fill={color} />
    </Svg>
  );
}

function ThanksIcon({ size = 15, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.7 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.5 0 5.6 3.6 4.4 7.1-1.7 4.8-9.2 9.4-9.2 9.4Z"
        fill="none" stroke={color} strokeWidth={1.9} strokeLinejoin="round" />
    </Svg>
  );
}

function GiftBubble({ content, isOwn, t, textColor, subColor, animate = false, onThank }) {
  const j = parseGiftContent(content) || {};
  const meta = giftMeta(j.gift_sku || '');
  const icon = j.icon || meta.icon;
  const qty = Math.max(1, Number(j.quantity) || 1);
  const diamonds = Number(j.diamonds) || (Number(j.unit_diamonds) || meta.diamonds) * qty;
  const label = giftLabel(t, icon, j.label || meta.label);
  const note = typeof j.note === 'string' ? j.note.trim() : '';
  const who = isOwn ? j.to_name : j.from_name;
  const parts = giftHeadParts(t, isOwn, who, tr(t, 'gifts.youSent', 'Você enviou um presente'), tr(t, 'gifts.youReceived', 'Enviou um presente para você'));
  const big = meta.tier === 'large' || meta.tier === 'legendary' || j.tier === 'large' || j.tier === 'legendary';

  const reduce = isReduceMotionEnabled();
  const pop = useRef(new Animated.Value(animate && !reduce ? 0.55 : 1)).current;
  const float = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return undefined;
    if (animate) Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: ND }).start();
    const loopF = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: ND }),
      Animated.timing(float, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: ND }),
    ]));
    const loopT = Animated.loop(Animated.timing(twinkle, { toValue: 1, duration: 2200, easing: Easing.linear, useNativeDriver: ND }));
    loopF.start(); loopT.start();
    return () => { loopF.stop(); loopT.stop(); };
  }, [animate, reduce, pop, float, twinkle]);

  const ty = float.interpolate({ inputRange: [0, 1], outputRange: [3, -4] });
  const tw = (a) => twinkle.interpolate({ inputRange: [0, a, Math.min(1, a + 0.18), 1], outputRange: [0.15, 1, 0.15, 0.15] });
  const tws = (a) => twinkle.interpolate({ inputRange: [0, a, Math.min(1, a + 0.18), 1], outputRange: [0.6, 1.15, 0.6, 0.6] });
  const chipBg = isOwn ? 'rgba(255,255,255,0.14)' : 'rgba(127,127,127,0.14)';
  const amount = humanizeCount(diamonds);
  const a11y = `${parts.before}${diamonds} ${tr(t, 'gifts.diamondsWord', 'diamantes')}${parts.after}. ${label}${qty > 1 ? ' x' + qty : ''}${note ? '. ' + note : ''}`;

  return (
    <View style={styles.wrap} accessibilityLabel={a11y}>
      <View style={styles.stage}>
        <View style={[styles.halo, big && styles.haloBig]} />
        <View style={styles.halo2} />
        <Animated.View style={{ transform: [{ translateY: ty }, { scale: pop }] }}>
          <LiveGiftGlyph icon={icon} size={big ? 84 : 76} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.sp1, { opacity: tw(0.1), transform: [{ scale: tws(0.1) }] }]}><Sparkle size={11} /></Animated.View>
        <Animated.View pointerEvents="none" style={[styles.sp2, { opacity: tw(0.45), transform: [{ scale: tws(0.45) }] }]}><Sparkle size={8} /></Animated.View>
        <Animated.View pointerEvents="none" style={[styles.sp3, { opacity: tw(0.75), transform: [{ scale: tws(0.75) }] }]}><Sparkle size={9} /></Animated.View>
        {qty > 1 ? <View style={styles.qtyBadge}><Text style={styles.qtyBadgeText}>{`×${qty}`}</Text></View> : null}
      </View>

      <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>{label}</Text>
      <View style={styles.headRow}>
        {parts.before ? <Text style={[styles.head, { color: subColor }]} numberOfLines={1}>{parts.before}</Text> : null}
        <View style={[styles.amount, { backgroundColor: chipBg }]}>
          <DiamondMono size={12} color={textColor} />
          <Text style={[styles.amountText, { color: textColor }]}>{amount}</Text>
        </View>
        {parts.after ? <Text style={[styles.head, { color: subColor, flexShrink: 1 }]} numberOfLines={1}>{parts.after}</Text> : null}
      </View>

      {note ? (
        <View style={[styles.note, { borderLeftColor: textColor }]}>
          <Text style={[styles.noteText, { color: textColor }]}>{note}</Text>
        </View>
      ) : null}

      {!isOwn && onThank ? (
        <TouchableOpacity onPress={onThank} activeOpacity={0.75} style={[styles.thank, { borderColor: textColor }]}
          accessibilityRole="button" accessibilityLabel={tr(t, 'gifts.thank', 'Agradecer')}>
          <ThanksIcon size={15} color={textColor} />
          <Text style={[styles.thankText, { color: textColor }]}>{tr(t, 'gifts.thank', 'Agradecer')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default memo(GiftBubble);

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2, width: 232 },
  stage: {
    width: 220, height: 132, borderRadius: 18, backgroundColor: '#0b0b0b', alignItems: 'center', justifyContent: 'center',
    marginBottom: 10, overflow: 'hidden',
    ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
  },
  halo: { position: 'absolute', width: 118, height: 118, borderRadius: 59, backgroundColor: 'rgba(255,255,255,0.06)' },
  haloBig: { width: 128, height: 128, borderRadius: 64, backgroundColor: 'rgba(255,255,255,0.09)' },
  halo2: { position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  sp1: { position: 'absolute', top: 18, left: 52 },
  sp2: { position: 'absolute', top: 30, right: 56 },
  sp3: { position: 'absolute', bottom: 22, right: 46 },
  qtyBadge: {
    position: 'absolute', top: 10, right: 10, paddingHorizontal: 8, height: 22, borderRadius: 11,
    backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center',
  },
  qtyBadgeText: { color: '#000', fontSize: 12, fontWeight: '900' },
  name: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginTop: 4, maxWidth: 224 },
  head: { fontSize: 12.5, fontWeight: '600' },
  amount: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 20, paddingHorizontal: 7, borderRadius: 10, marginHorizontal: 4 },
  amountText: { fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  note: { alignSelf: 'stretch', marginTop: 10, paddingLeft: 10, paddingVertical: 2, borderLeftWidth: 2 },
  noteText: { fontSize: 14.5, lineHeight: 19, fontStyle: 'italic' },
  thank: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'stretch',
    height: 36, borderRadius: 18, borderWidth: 1.2, marginTop: 10,
  },
  thankText: { fontSize: 14, fontWeight: '700' },
});
