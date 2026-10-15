// [2026-10-15 native-onboarding] Animação de marca da tela de boas-vindas.
// Tudo em transform/opacity com useNativeDriver → roda na UI thread (não
// trava com o JS ocupado no boot). Squircle entra com mola, anéis "respiram",
// os 3 pontos do balão digitam (indicador de digitação), leve flutuação.
// Reduzir movimento: estático, sem loops.
import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const BUBBLE = 'M26 40c0-7.7 6.3-14 14-14h16c7.7 0 14 6.3 14 14v8c0 7.7-6.3 14-14 14H44l-10 9v-9.6c-4.8-2.2-8-7-8-12.4v-9z';

export default function BrandHero({ size = 112, fg = '#111111', bg = '#ffffff', reduced = false }) {
  const enter = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (reduced) { enter.setValue(1); return undefined; }
    const loops = [];
    Animated.spring(enter, { toValue: 1, friction: 6, tension: 70, useNativeDriver: true }).start();
    const r = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    const f = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(float, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    const d = Animated.loop(Animated.sequence([
      Animated.delay(250),
      Animated.stagger(140, dots.map((v) => Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]))),
      Animated.delay(700),
    ]));
    const tm = setTimeout(() => { r.start(); f.start(); d.start(); }, 380);
    loops.push(r, f, d);
    return () => { clearTimeout(tm); loops.forEach((l) => { try { l.stop(); } catch {} }); };
  }, [reduced, enter, ring, float, dots]);

  const k = size / 96;
  const scale = enter.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const ty = float.interpolate({ inputRange: [0, 1], outputRange: [0, -5] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.22, 0] });
  const ring2Scale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ring2Opacity = ring.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 0.14, 0] });
  const box = size * 1.9;

  return (
    <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }} accessible={false} importantForAccessibility="no-hide-descendants">
      {!reduced && (
        <>
          <Animated.View pointerEvents="none" style={[st.ring, { width: size, height: size, borderRadius: size * 0.3, borderColor: fg, opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
          <Animated.View pointerEvents="none" style={[st.ring, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: fg, borderWidth: 0, opacity: ring2Opacity, transform: [{ scale: ring2Scale }] }]} />
        </>
      )}
      <Animated.View style={{ opacity: enter, transform: [{ translateY: ty }, { scale }] }}>
        <View style={{ width: size, height: size, borderRadius: 28 * k, backgroundColor: fg, overflow: 'hidden' }}>
          <Svg width={size} height={size} viewBox="0 0 96 96" fill="none">
            <Path d={BUBBLE} stroke={bg} strokeWidth="4.5" strokeLinejoin="round" />
          </Svg>
          {dots.map((v, i) => (
            <Animated.View
              key={i}
              style={{
                position: 'absolute',
                left: (39 + i * 9 - 3.2) * k,
                top: (44 - 3.2) * k,
                width: 6.4 * k,
                height: 6.4 * k,
                borderRadius: 3.2 * k,
                backgroundColor: bg,
                opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
                transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3.2 * k] }) }],
              }}
            />
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 2 },
});
