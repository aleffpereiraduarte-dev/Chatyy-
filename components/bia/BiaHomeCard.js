// [2026-10-15 bia-design] Card da Bia no topo da lista de conversas: mini-orb vivo,
// "Bia · IA", sugestão do momento (muda com a hora do dia) e atalho direto p/ o
// modo voz. [bia-frase 2026-10-19] subtítulo = "Bom dia, Nome · frase de 12 h" (até 2 linhas). Mesmo footprint das linhas (minHeight 74) — layout da lista não muda.
import React, { memo, useMemo, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming, withDelay, cancelAnimation, Easing } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { THEME_V2, Grafite } from '../../constants/theme';
import { useReducedMotion } from '../reducedMotion';
import BiaOrb from './BiaOrb';
import { BiaPressScale, GlyphWave } from './BiaUI';
import { useLanguageOptional } from '../../context/LanguageContext';
import { useBiaDaily, biaGreetingKey } from '../../services/biaDaily'; // [bia-frase 2026-10-19]

function suggestion(t) {
  const h = new Date().getHours();
  if (h < 12) return { hello: t('one.goodMorning'), tip: t('one.todaySummary') };
  if (h < 18) return { hello: t('one.goodAfternoon'), tip: t('one.unreadEmails') };
  return { hello: t('one.goodEvening'), tip: t('one.tomorrowAgenda') };
}

// [2026-10-20 grafite] tema v2: cartão grafite (gradiente 135°) + faixa de brilho
// passando a cada ~5 s. Reanimated na UI thread (zero render por quadro);
// Reduzir Movimento → sem brilho. Footprint igual (margem 4 + 66 = 74).
const BAND_W = 90;
const Shine = memo(function Shine() {
  const rm = useReducedMotion();
  const w = useSharedValue(0);
  const p = useSharedValue(0);
  useEffect(() => {
    if (rm) { cancelAnimation(p); p.value = 0; return undefined; }
    p.value = 0;
    p.value = withRepeat(withSequence(withDelay(2800, withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.quad) })), withTiming(0, { duration: 0 })), -1, false);
    return () => cancelAnimation(p);
  }, [rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const onLayout = useCallback((e) => { w.value = e.nativeEvent.layout.width; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ast = useAnimatedStyle(() => ({ opacity: p.value > 0 ? 1 : 0, transform: [{ translateX: -BAND_W + p.value * (w.value + BAND_W * 2) }, { rotate: '12deg' }] }));
  if (rm) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <Animated.View style={[{ position: 'absolute', top: -40, bottom: -40, left: 0, width: BAND_W }, ast]}>
        <Svg width={BAND_W} height="100%" preserveAspectRatio="none" viewBox="0 0 10 10">
          <Defs>
            <LinearGradient id="biaShine" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
              <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.09" />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="10" height="10" fill="url(#biaShine)" />
        </Svg>
      </Animated.View>
    </View>
  );
});
const _cardCache = {};
function _cardStyle(isDark) {
  const k = isDark ? 'd' : 'l';
  if (_cardCache[k]) return _cardCache[k];
  const g = isDark ? Grafite.dark.biaCard : Grafite.light.biaCard;
  const grad = `linear-gradient(135deg, ${g[0]} 0%, ${g[1]} 100%)`;
  const sh = isDark ? 'inset 0px 1px 0px rgba(255,255,255,0.06)' : '0px 1px 2px rgba(0,0,0,0.035), 0px 8px 24px rgba(0,0,0,0.045)';
  _cardCache[k] = [hc.card, Platform.OS === 'web'
    ? { backgroundColor: g[1], backgroundImage: grad, boxShadow: sh }
    : { backgroundColor: g[1], experimental_backgroundImage: grad, boxShadow: sh }];
  return _cardCache[k];
}

function BiaHomeCard({ isDark, t, router, P, avatarSize = 54, compact = false, nameStyle, previewStyle }) {
  const sug = useMemo(() => suggestion(t), [t]);
  // [bia-frase 2026-10-19] "Bom dia, Aleff" + frase de 12 h (servidor bia_daily_line, cache MMKV).
  // Sem resposta ainda / kill switch globalThis.__chatyy_bia_daily = false → subtítulo antigo.
  const _lc = useLanguageOptional();
  const daily = useBiaDaily(_lc?.language || 'pt-BR');
  let hello = sug.hello;
  let tip = sug.tip;
  if (daily && daily.line) {
    const word = t(biaGreetingKey());
    hello = daily.name ? `${word}, ${daily.name}` : word;
    tip = daily.line;
  }
  const open = (q) => { try { router.push(q ? `/one?${q}` : '/one'); } catch {} };
  if (THEME_V2) {
    const fg = Grafite.light.biaCardText;
    return (
      <View style={hc.cardWrap}>
        <BiaPressScale onPress={() => open()} scaleTo={0.985} accessibilityLabel={`${t('one.title')}, ${hello}, ${tip}`} style={_cardStyle(isDark)}>
          <Shine />
          <BiaOrb size={Math.min(avatarSize, 46)} lite isDark />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={hc.titleRow}>
              <Text maxFontSizeMultiplier={1.35} style={[nameStyle, { flex: 0, color: fg }]}>{t('one.title')}</Text>
              <View style={[hc.badge, { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
                <Text maxFontSizeMultiplier={1.1} style={[hc.badgeText, { color: 'rgba(242,242,239,0.75)' }]}>{t('chat.aiBadge')}</Text>
              </View>
            </View>
            <Text maxFontSizeMultiplier={1.3} style={[previewStyle, { color: 'rgba(242,242,239,0.65)', marginTop: 2, marginRight: 0 }]} numberOfLines={1} ellipsizeMode="tail">
              <Text style={{ color: fg, fontWeight: '500' }}>{hello}</Text>
              {` · ${tip}`}
            </Text>
          </View>
          <BiaPressScale onPress={() => open('voice=1')} scaleTo={0.9} hitSlop={8} accessibilityLabel={t('one.voiceConversation')} style={[hc.voice, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
            <GlyphWave size={16} color={fg} />
          </BiaPressScale>
        </BiaPressScale>
      </View>
    );
  }
  return (
    <BiaPressScale onPress={() => open()} scaleTo={0.985} accessibilityLabel={`${t('one.title')}, ${hello}, ${tip}`} style={[hc.row, compact && hc.rowCompact]}>
      <BiaOrb size={avatarSize} lite isDark={isDark} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={hc.titleRow}>
          <Text maxFontSizeMultiplier={1.35} style={[nameStyle, { flex: 0, color: P.text }]}>{t('one.title')}</Text>
          <View style={[hc.badge, { backgroundColor: P.chipBg }]}>
            <Text maxFontSizeMultiplier={1.1} style={[hc.badgeText, { color: P.sub }]}>{t('chat.aiBadge')}</Text>
          </View>
        </View>
        <Text maxFontSizeMultiplier={1.3} style={[previewStyle, { color: P.sub, marginTop: compact ? 2 : 3, marginRight: 0 }]} numberOfLines={1} ellipsizeMode="tail">
          <Text style={{ color: P.text, fontWeight: '500' }}>{hello}</Text>
          {` · ${tip}`}
        </Text>
      </View>
      <BiaPressScale
        onPress={() => open('voice=1')}
        scaleTo={0.9}
        hitSlop={8}
        accessibilityLabel={t('one.voiceConversation')}
        style={[hc.voice, { backgroundColor: isDark ? '#FFFFFF' : '#0D0D0D' }]}
      >
        <GlyphWave size={16} color={isDark ? '#000000' : '#FFFFFF'} />
      </BiaPressScale>
    </BiaPressScale>
  );
}

const hc = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10, minHeight: 74 },
  // [2026-10-18 compact-list] mesmo ritmo das linhas compactas (72 / vão 12)
  rowCompact: { gap: 12, paddingVertical: 9, minHeight: 72 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  voice: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  cardWrap: { paddingHorizontal: 12, paddingVertical: 4, minHeight: 74 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 66, borderRadius: Grafite.radius.card, overflow: 'hidden' },
});

export default memo(BiaHomeCard);
