// [2026-10-20 grafite] Anel prateado do tema v2 em volta de avatares/status.
// O mockup usa conic-gradient; no RN aproximamos com react-native-svg (gradiente
// linear diagonal com os mesmos 5 tons de Grafite.*.ring). Estático (desenha 1×,
// sem animação, pointerEvents none). Tema antigo (themeV2On() = false) → só os filhos.
import React, { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Circle } from 'react-native-svg';
import { THEME_V2, Grafite } from '../../constants/theme';

let _uid = 0;

function SilverRing({ size, isDark, width = 2, gap = 3, children, style }) {
  const id = useMemo(() => `slvr${++_uid}`, []);
  if (!THEME_V2) return children || null;
  const outer = size + (width + gap) * 2;
  const stops = (isDark ? Grafite.dark : Grafite.light).ring;
  return (
    <View style={[{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Svg width={outer} height={outer} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id={id} x1="0.15" y1="0" x2="0.85" y2="1">
            {stops.map((c, i) => <Stop key={i} offset={String(i / (stops.length - 1))} stopColor={c} />)}
          </LinearGradient>
        </Defs>
        <Circle cx={outer / 2} cy={outer / 2} r={outer / 2 - width / 2} stroke={`url(#${id})`} strokeWidth={width} fill="none" />
      </Svg>
      {children}
    </View>
  );
}

export default memo(SilverRing);
