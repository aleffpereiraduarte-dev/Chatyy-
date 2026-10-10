/**
 * LiveGiftFullscreen — animação de tela cheia para presentes grandes
 * (>= BIG_GIFT_DIAMONDS). RN Animated + SVG puro, sem dependência nativa.
 *
 * Linha do tempo (~2.9s): véu escuro sobe → arte entra com mola (0.2→1.15→1)
 * → anel de raios gira → 10 faíscas se espalham → legenda "Fulano enviou X"
 * → tudo some. Um por vez (fila no store); pointerEvents="none".
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Dimensions } from 'react-native';
import Svg, { Line, Circle } from 'react-native-svg';
import { useLanguage } from '../../context/LanguageContext';
import LiveGiftGlyph from './LiveGiftGlyph';
import { giftLabel } from './liveEngageConfig';
import { useEngageSelector, selGiftBig } from './liveEngageStore';

const SPARKS = 10;

function Rays({ size }) {
  const lines = [];
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    const r1 = size * 0.3;
    const r2 = size * (i % 2 ? 0.44 : 0.5);
    lines.push(
      <Line
        key={i}
        x1={size / 2 + Math.cos(a) * r1} y1={size / 2 + Math.sin(a) * r1}
        x2={size / 2 + Math.cos(a) * r2} y2={size / 2 + Math.sin(a) * r2}
        stroke="#fff" strokeOpacity={i % 2 ? 0.35 : 0.6} strokeWidth={2} strokeLinecap="round"
      />,
    );
  }
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={size * 0.27} fill="none" stroke="#fff" strokeOpacity={0.25} strokeWidth={1.5} />
      {lines}
    </Svg>
  );
}

const BigGift = memo(function BigGift({ g, onDone }) {
  const { t } = useLanguage();
  const { width: W, height: H } = Dimensions.get('window');
  const veil = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const spark = useRef(new Animated.Value(0)).current;
  const size = Math.min(W, H) * 0.5;
  const sparks = useMemo(() => Array.from({ length: SPARKS }, (_, i) => {
    const a = (Math.PI * 2 * i) / SPARKS + Math.random() * 0.4;
    const d = size * (0.55 + Math.random() * 0.35);
    return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, s: 4 + Math.random() * 5 };
  }), [size]);

  useEffect(() => {
    const spinLoop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 4000, easing: Easing.linear, useNativeDriver: true }));
    spinLoop.start();
    Animated.sequence([
      Animated.parallel([
        Animated.timing(veil, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(pop, { toValue: 1, friction: 5, tension: 70, useNativeDriver: true }),
        Animated.timing(spark, { toValue: 1, duration: 1100, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.delay(1300),
      Animated.parallel([
        Animated.timing(veil, { toValue: 0, duration: 320, useNativeDriver: true }),
        Animated.timing(pop, { toValue: 0, duration: 320, useNativeDriver: true }),
      ]),
    ]).start(() => { spinLoop.stop(); onDone(); });
    return () => spinLoop.stop();
  }, [veil, pop, spin, spark, onDone]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.veil, { opacity: veil.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }) }]} />
      <View style={styles.center}>
        <Animated.View style={{ position: 'absolute', opacity: veil, transform: [{ rotate }] }}>
          <Rays size={size * 1.5} />
        </Animated.View>
        {sparks.map((p, i) => (
          <Animated.View
            key={i}
            style={[styles.spark, {
              width: p.s, height: p.s, borderRadius: p.s / 2,
              opacity: spark.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateX: spark.interpolate({ inputRange: [0, 1], outputRange: [0, p.dx] }) },
                { translateY: spark.interpolate({ inputRange: [0, 1], outputRange: [0, p.dy] }) },
              ],
            }]}
          />
        ))}
        <Animated.View style={{
          opacity: pop.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 1] }),
          transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }],
        }}
        >
          <LiveGiftGlyph icon={g.icon} size={size} />
        </Animated.View>
        <Animated.View style={[styles.caption, { opacity: veil, transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}>
          <Text style={styles.name} numberOfLines={1}>{g.name}</Text>
          <Text style={styles.sub} numberOfLines={1}>{`${t('liveEng.giftSent')} ${giftLabel(t, g.icon, g.label)}`}</Text>
        </Animated.View>
      </View>
    </View>
  );
});

function LiveGiftFullscreen({ engage }) {
  const g = useEngageSelector(engage, selGiftBig);
  const onDone = useRef(() => engage?.bigGiftDone()).current;
  if (!g) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 90 }]}>
      <BigGift key={g.id} g={g} onDone={onDone} />
    </View>
  );
}

export default memo(LiveGiftFullscreen);

const styles = StyleSheet.create({
  veil: { backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  spark: { position: 'absolute', backgroundColor: '#fff' },
  caption: { position: 'absolute', bottom: '26%', alignItems: 'center', paddingHorizontal: 24 },
  name: { color: '#fff', fontSize: 20, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  sub: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '700', marginTop: 2, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
});
