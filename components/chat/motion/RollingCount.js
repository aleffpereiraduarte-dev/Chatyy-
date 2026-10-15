// [2026-10-14 motion] Contador que "rola" (Telegram): ao mudar, o número antigo
// sobe e some e o novo entra por baixo (desce quando diminui). Native driver.
// Sem motion (flag/Reduzir movimento) = troca seca. Largura acompanha o texto.
//   <RollingCount value={n} style={textStyle} lineHeight={14} format={(n) => (n > 99 ? '99+' : String(n))} />
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { MOTION_ND, motionOn } from './motionFlag';

export default function RollingCount({ value, style, lineHeight = 14, format }) {
  const fmt = (v) => (format ? format(v) : String(v));
  const [pair, setPair] = useState({ cur: value, prev: null, dir: 1, k: 0 });
  const prog = useRef(new Animated.Value(1)).current;
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    const old = last.current;
    last.current = value;
    if (!motionOn() || fmt(value) === fmt(old)) { setPair(p => ({ cur: value, prev: null, dir: 1, k: p.k + 1 })); return; }
    setPair(p => ({ cur: value, prev: old, dir: Number(value) >= Number(old) ? 1 : -1, k: p.k + 1 }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // layout effect: zera o progresso ANTES da pintura do par (sem 1 frame do fim)
  useLayoutEffect(() => {
    if (pair.prev == null) return undefined;
    prog.setValue(0);
    const a = Animated.timing(prog, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: MOTION_ND });
    a.start(({ finished }) => { if (finished) setPair(p => (p.k === pair.k ? { ...p, prev: null } : p)); });
    return () => a.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.k]);
  if (pair.prev == null) return <Text style={style}>{fmt(pair.cur)}</Text>;
  const d = lineHeight * pair.dir;
  return (
    <View style={{ height: lineHeight, overflow: 'hidden', justifyContent: 'center' }}>
      <Animated.Text style={[style, { opacity: prog.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }), transform: [{ translateY: prog.interpolate({ inputRange: [0, 1], outputRange: [d, 0] }) }] }]}>
        {fmt(pair.cur)}
      </Animated.Text>
      <Animated.Text style={[style, { position: 'absolute', alignSelf: 'center', opacity: prog.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), transform: [{ translateY: prog.interpolate({ inputRange: [0, 1], outputRange: [0, -d] }) }] }]}>
        {fmt(pair.prev)}
      </Animated.Text>
    </View>
  );
}
