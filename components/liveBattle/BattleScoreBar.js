// [live-pk 2026-10-10] Barra de placar da Batalha PK (P&B): esquerda branca
// (meu host) x direita cinza (adversário). A divisória desliza suave conforme
// as curtidas; o número de quem pontuou dá um "pulo" curto.
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { scoreRatio } from './battleLogic';
import { humanizeCount } from '../live/liveEngageConfig';

const H = 22;

function useBump(value) {
  const v = useRef(new Animated.Value(1)).current;
  const prev = useRef(value);
  useEffect(() => {
    if (value > prev.current) {
      v.stopAnimation();
      v.setValue(1.22);
      Animated.spring(v, { toValue: 1, friction: 5, tension: 160, useNativeDriver: true }).start();
    }
    prev.current = value;
  }, [value, v]);
  return v;
}

function BattleScoreBar({ left, right, a11yLabel }) {
  const [w, setW] = useState(0);
  const ratio = scoreRatio(left, right);
  const anim = useRef(new Animated.Value(ratio)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: ratio, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [ratio, anim]);
  const leftW = anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(1, w)] });
  const bumpL = useBump(left);
  const bumpR = useBump(right);
  return (
    <View
      style={styles.wrap}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      accessibilityLabel={a11yLabel}
    >
      <View style={styles.rightFill} />
      <Animated.View style={[styles.leftFill, { width: leftW }]} />
      <Animated.View style={[styles.divider, { left: Animated.subtract(leftW, 1) }]} />
      <View style={styles.labels} pointerEvents="none">
        <Animated.Text style={[styles.scoreL, { transform: [{ scale: bumpL }] }]} numberOfLines={1}>{humanizeCount(left)}</Animated.Text>
        <Animated.Text style={[styles.scoreR, { transform: [{ scale: bumpR }] }]} numberOfLines={1}>{humanizeCount(right)}</Animated.Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: H, borderRadius: 0, overflow: 'hidden', backgroundColor: '#5c5c5c' },
  rightFill: { ...StyleSheet.absoluteFillObject, backgroundColor: '#6b6b6b' },
  leftFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#ffffff' },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#000' },
  labels: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
  scoreL: { color: '#000', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  scoreR: { color: '#fff', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
});

export default memo(BattleScoreBar);

/** Cronômetro "4:59" (re-render 1x/s só aqui). */
export const BattleClock = memo(function BattleClock({ endsAt, offset = 0, label, style, textStyle }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [endsAt]);
  const left = Math.max(0, (endsAt || 0) - (now + offset));
  const total = Math.ceil(left / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const urgent = endsAt && total <= 10;
  return (
    <View style={[clk.chip, urgent && clk.urgent, style]}>
      {label ? <Text style={[clk.label, urgent && clk.labelUrgent]}>{label}</Text> : null}
      <Text style={[clk.time, urgent && clk.timeUrgent, textStyle]}>{`${mm}:${ss < 10 ? '0' : ''}${ss}`}</Text>
    </View>
  );
});

const clk = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.72)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.35)',
  },
  urgent: { backgroundColor: '#fff' },
  label: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  labelUrgent: { color: '#000' },
  time: { color: '#fff', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timeUrgent: { color: '#000' },
});
