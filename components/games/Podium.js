// components/games/Podium.js — [jogos 2026-10-18 polish 2] pódio final (Quiz/Forca/Cartas em grupo).
// 2º | 1º | 3º: os blocos sobem em mola um depois do outro (3º → 2º → 1º), o nome/pontos aparecem
// em cima e o 1º ganha a coroa dourada que cai girando. Movimento reduzido = pódio pronto, sem animação.
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withSpring, withTiming, Easing } from 'react-native-reanimated';
import { IconCrown } from './GameIcons';
import { useRM } from './motion';

const H = [92, 64, 46]; // altura do bloco por posição (1º, 2º, 3º)
const ORDER_DELAY = [760, 380, 0]; // 3º sobe primeiro, 1º por último

function Step({ place, name, score, pal, rm, w }) {
  const g = useSharedValue(rm ? 1 : 0);
  const lab = useSharedValue(rm ? 1 : 0);
  const crown = useSharedValue(rm ? 1 : 0);
  useEffect(() => {
    if (rm) return;
    const dl = ORDER_DELAY[place];
    g.value = withDelay(dl, withSpring(1, { damping: 13, stiffness: 120 }));
    lab.value = withDelay(dl + 220, withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) }));
    if (place === 0) crown.value = withDelay(dl + 420, withSpring(1, { damping: 7, stiffness: 140 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const h = H[place];
  // só transform (sem mexer em layout por quadro): o bloco sobe de dentro de uma janela recortada
  const blockSt = useAnimatedStyle(() => ({ transform: [{ translateY: h * (1 - g.value) }] }));
  const labSt = useAnimatedStyle(() => ({ opacity: lab.value, transform: [{ translateY: (1 - lab.value) * 10 }] }));
  const crownSt = useAnimatedStyle(() => ({ opacity: crown.value, transform: [{ translateY: (1 - crown.value) * -30 }, { rotate: `${(1 - crown.value) * 120}deg` }, { scale: 0.5 + 0.5 * crown.value }] }));
  const top = place === 0;
  return (
    <View style={{ width: w, alignItems: 'center', justifyContent: 'flex-end' }}>
      {top ? <Animated.View style={[{ marginBottom: 2 }, crownSt]}><IconCrown size={26} color={pal.accent} /></Animated.View> : null}
      <Animated.View style={[{ alignItems: 'center', marginBottom: 6 }, labSt]}>
        <Text style={{ color: pal.ink, fontWeight: top ? '900' : '700', fontSize: top ? 15 : 13.5, maxWidth: w - 4 }} numberOfLines={1}>{name}</Text>
        {score ? <Text style={{ color: pal.sub, fontWeight: '700', fontSize: 12 }} numberOfLines={1}>{score}</Text> : null}
      </Animated.View>
      <View style={{ width: w - 10, height: h, overflow: 'hidden' }}>
        <Animated.View style={[s.block, { height: h, backgroundColor: top ? pal.strong : pal.card2, borderColor: top ? pal.strong : pal.line }, blockSt]}>
          <Text style={{ color: top ? pal.onStrong : pal.ink, fontWeight: '900', fontSize: top ? 26 : 20, marginTop: 6 }}>{place + 1}</Text>
        </Animated.View>
      </View>
    </View>
  );
}

/** rows = [{e, name, score}] já na ordem final (1º primeiro). */
export default function Podium({ rows, pal, width = 300 }) {
  const rm = useRM();
  const top = (rows || []).slice(0, 3);
  if (top.length < 2) return null;
  const w = Math.min(110, Math.floor(width / 3));
  const order = top.length === 2 ? [1, 0] : [1, 0, 2]; // 2º à esquerda, 1º no meio, 3º à direita
  return (
    <View style={[s.wrap, { height: H[0] + 78 }]} accessibilityRole="summary">
      {order.map((k) => <Step key={top[k].e} place={k} name={top[k].name} score={top[k].score} pal={pal} rm={rm} w={w} />)}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', alignSelf: 'stretch', marginTop: 14 },
  block: { borderTopLeftRadius: 12, borderTopRightRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
});
