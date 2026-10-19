// components/games/motion.js — [jogos 2026-10-18 polish 2] primitivas de animação dos jogos.
// Tudo roda no thread de UI (Reanimated worklets): nada de setState por quadro.
//  - useRM(): "reduzir movimento" do sistema (ou globalThis.__chatyy_games_rm=true para testar).
//  - PressScale: botão com afundar/soltar em mola (feedback de toque).
//  - shake(): tremida de "não pode".
//  - DrawPath / DrawLine / DrawCircle: traço SVG que se "desenha" (strokeDashoffset animado).
//    No web (animatedProps em SVG não é confiável) e com movimento reduzido = traço pronto com fade.
import React, { useEffect } from 'react';
import { Pressable, Platform } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps, withSpring, withTiming, withSequence, withDelay, Easing, useReducedMotion,
} from 'react-native-reanimated';
import { Path, Line, Circle } from 'react-native-svg';

export const IS_WEB = Platform.OS === 'web';
export const APressable = Animated.createAnimatedComponent(Pressable);
const APath = Animated.createAnimatedComponent(Path);
const ALine = Animated.createAnimatedComponent(Line);
const ACircle = Animated.createAnimatedComponent(Circle);
export { APath, ALine, ACircle };

export function useRM() {
  let rm = false;
  try { rm = !!useReducedMotion(); } catch {}
  try { if (globalThis.__chatyy_games_rm === true) rm = true; } catch {}
  return rm;
}

/** Botão com escala no toque. `style` precisa ser objeto/array (não função). */
export function PressScale({ children, style, scaleTo = 0.94, disabled, onPress, rm, onPressIn, onPressOut, ...rest }) {
  const s = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <APressable
      disabled={disabled}
      onPress={onPress}
      onPressIn={(e) => { if (!rm) s.value = withTiming(scaleTo, { duration: 70 }); if (onPressIn) onPressIn(e); }}
      onPressOut={(e) => { s.value = withSpring(1, { damping: 13, stiffness: 340 }); if (onPressOut) onPressOut(e); }}
      style={[style, st]}
      {...rest}
    >
      {children}
    </APressable>
  );
}

/** Tremida horizontal (valor em px num shared value). */
export function shake(sv, amp = 8, rm = false) {
  if (rm) { sv.value = 0; return; }
  sv.value = withSequence(
    withTiming(-amp, { duration: 45 }), withTiming(amp, { duration: 70 }), withTiming(-amp * 0.6, { duration: 60 }),
    withTiming(amp * 0.3, { duration: 55 }), withTiming(0, { duration: 50 }),
  );
}
/** "Pulo" de escala (1 → to → 1). */
export function pop(sv, to = 1.12, rm = false) {
  if (rm) { sv.value = 1; return; }
  sv.value = withSequence(withTiming(to, { duration: 110, easing: Easing.out(Easing.quad) }), withSpring(1, { damping: 11, stiffness: 220 }));
}

function useDraw(animate, delay, duration, rm) {
  const p = useSharedValue(animate && !rm ? 0 : 1);
  // só DISPARA quando animate vira true; quando vira false não corta a animação em curso
  useEffect(() => {
    if (animate && !rm) { p.value = 0; p.value = withDelay(delay || 0, withTiming(1, { duration: duration || 320, easing: Easing.out(Easing.cubic) })); }
    else if (rm) p.value = 1;
  }, [animate, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  return p;
}
// No web: o traço aparece pronto (opacity anima via View pai se quiser).
function useDashProps(p, len) {
  return useAnimatedProps(() => ({ strokeDashoffset: len * (1 - p.value) }));
}

/** Path que se desenha. `len` = comprimento aproximado (pode sobrar um pouco). */
export function DrawPath({ d, len = 100, animate = true, delay = 0, duration, rm, ...rest }) {
  const p = useDraw(animate, delay, duration, rm);
  const ap = useDashProps(p, len);
  if (IS_WEB || rm) return <Path d={d} {...rest} />;
  return <APath d={d} strokeDasharray={[len, len]} animatedProps={ap} {...rest} />;
}
export function DrawLine({ x1, y1, x2, y2, animate = true, delay = 0, duration, rm, ...rest }) {
  const len = Math.hypot(x2 - x1, y2 - y1) + 2;
  const p = useDraw(animate, delay, duration, rm);
  const ap = useDashProps(p, len);
  if (IS_WEB || rm) return <Line x1={x1} y1={y1} x2={x2} y2={y2} {...rest} />;
  return <ALine x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={[len, len]} animatedProps={ap} {...rest} />;
}
export function DrawCircle({ cx, cy, r, animate = true, delay = 0, duration, rm, ...rest }) {
  const len = 2 * Math.PI * r + 2;
  const p = useDraw(animate, delay, duration, rm);
  const ap = useDashProps(p, len);
  if (IS_WEB || rm) return <Circle cx={cx} cy={cy} r={r} {...rest} />;
  return <ACircle cx={cx} cy={cy} r={r} strokeDasharray={[len, len]} animatedProps={ap} {...rest} />;
}

/** Entrada simples (fade + deslize) disparada quando `k` muda. */
export function useEnter(k, rm, { dx = 0, dy = 14, duration = 260 } = {}) {
  const e = useSharedValue(rm ? 1 : 0);
  useEffect(() => {
    if (rm) { e.value = 1; return; }
    e.value = 0;
    e.value = withTiming(1, { duration, easing: Easing.out(Easing.cubic) });
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  return useAnimatedStyle(() => ({
    opacity: e.value,
    transform: [{ translateX: dx * (1 - e.value) }, { translateY: dy * (1 - e.value) }],
  }));
}
