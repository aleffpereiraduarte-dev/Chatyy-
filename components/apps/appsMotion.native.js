// [2026-10-15 apps-motion] Motion do painel de Apps — NATIVO.
//
// Tudo na UI thread:
//   • AppsItem  — Reanimated Layout Animations: entrada custom (fade + escala
//                 0.92→1 + sobe 14px, spring, delay da cascata), saída (encolhe
//                 + some) e LinearTransition spring quando a busca reorganiza;
//   • Jiggle    — tremor do "modo editar" (withRepeat na UI thread);
//   • Pop       — pop de badge / tecla limpar (RN Animated, native driver);
//   • TilePress — PressableScale (spring + haptic).
// OTA SAFETY: Reanimated só quando utils/threadKeyboard já o carregou neste
// binário (mesma guarda do AttachSheet/SwipeReplyRow). Sem ele: RN Animated
// (native driver) p/ entrada/tremor + LayoutAnimation p/ reorganizar a busca.
// Reduzir Movimento → sem entrada/saída/tremor/layout (estático).
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, LayoutAnimation, View } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import PressableScale from '../PressableScale';
import { isReduceMotionEnabled, useReducedMotion } from '../reducedMotion';

let Rea = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try { Rea = require('react-native-reanimated'); } catch { Rea = null; } // eslint-disable-line global-require
}
const REA_OK = !!(
  Rea && Rea.default && Rea.default.View && Rea.withSpring && Rea.withTiming && Rea.withDelay
  && Rea.withRepeat && Rea.withSequence && Rea.useSharedValue && Rea.useAnimatedStyle
  && Rea.cancelAnimation && Rea.LinearTransition
);
export const APPS_MOTION_ENGINE = REA_OK ? 'reanimated' : 'animated';

const withSpring = REA_OK ? Rea.withSpring : null;
const withTiming = REA_OK ? Rea.withTiming : null;
const withDelay = REA_OK ? Rea.withDelay : null;
const ENTER_SPRING = { damping: 15, stiffness: 190, mass: 0.85 };

// Reanimated: a busca reorganiza via `layout`; sem Reanimated, LayoutAnimation.
export function prepareLayoutChange() {
  if (REA_OK || isReduceMotionEnabled()) return;
  try {
    LayoutAnimation.configureNext({
      duration: 320,
      create: { type: 'easeOut', property: 'scaleXY', duration: 220 },
      update: { type: 'spring', springDamping: 0.78 },
      delete: { type: 'easeIn', property: 'opacity', duration: 140 },
    });
  } catch {}
}

function makeEntering(delay) {
  const d = Math.max(0, delay | 0);
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 14 }, { scale: 0.92 }] },
      animations: {
        opacity: withDelay(d, withTiming(1, { duration: 240 })),
        transform: [
          { translateY: withDelay(d, withSpring(0, ENTER_SPRING)) },
          { scale: withDelay(d, withSpring(1, ENTER_SPRING)) },
        ],
      },
    };
  };
}
function exitingAnim() {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 150 }),
      transform: [{ scale: withTiming(0.82, { duration: 170 }) }],
    },
  };
}
const LAYOUT = REA_OK
  ? Rea.LinearTransition.springify().damping(19).stiffness(210).mass(0.9)
  : null;

function AppsItemRea({ enterDelay = 0, style, children, testID }) {
  const reduce = useReducedMotion();
  // Entrada lida só no mount (Reanimated) — memo evita recriar o worklet por render.
  const entering = useMemo(() => makeEntering(enterDelay), []); // eslint-disable-line react-hooks/exhaustive-deps
  const RView = Rea.default.View;
  if (reduce) return <View style={style} testID={testID}>{children}</View>;
  return (
    <RView style={style} testID={testID} entering={entering} exiting={exitingAnim} layout={LAYOUT}>
      {children}
    </RView>
  );
}

function AppsItemLegacy({ enterDelay = 0, style, children, testID }) {
  const reduce = isReduceMotionEnabled();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) return undefined;
    const a = Animated.sequence([
      Animated.delay(Math.max(0, enterDelay | 0)),
      Animated.spring(v, { toValue: 1, tension: 170, friction: 13, useNativeDriver: true }),
    ]);
    a.start();
    return () => a.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View
      testID={testID}
      style={[style, {
        opacity: v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
        transform: [
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
          { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
        ],
      }]}
    >
      {children}
    </Animated.View>
  );
}

export const AppsItem = REA_OK ? AppsItemRea : AppsItemLegacy;

function JiggleRea({ active, seed = 0, children, style }) {
  const reduce = useReducedMotion();
  const rot = Rea.useSharedValue(0);
  const on = !!active && !reduce;
  useEffect(() => {
    if (on) {
      const amp = 1.5 + (seed % 3) * 0.15;
      const dur = 120 + (seed % 4) * 8;
      rot.value = Rea.withSequence(
        withTiming(seed % 2 ? amp : -amp, { duration: dur / 2 }),
        Rea.withRepeat(withTiming(seed % 2 ? -amp : amp, { duration: dur }), -1, true),
      );
    } else {
      Rea.cancelAnimation(rot);
      rot.value = withTiming(0, { duration: 120 });
    }
    return () => { Rea.cancelAnimation(rot); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  const st = Rea.useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  const RView = Rea.default.View;
  return <RView style={[style, st]}>{children}</RView>;
}

function JiggleLegacy({ active, seed = 0, children, style }) {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  const on = !!active && !reduce;
  useEffect(() => {
    if (!on) { v.stopAnimation(); v.setValue(0); return undefined; }
    const dur = 120 + (seed % 4) * 8;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: dur, useNativeDriver: true }),
      Animated.timing(v, { toValue: -1, duration: dur, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  return (
    <Animated.View style={[style, { transform: [{ rotate: v.interpolate({ inputRange: [-1, 1], outputRange: ['-1.5deg', '1.5deg'] }) }] }]}>
      {children}
    </Animated.View>
  );
}

export const Jiggle = REA_OK ? JiggleRea : JiggleLegacy;

// Pop: escala 0.3→1.18→1 (spring) no mount e quando popKey muda.
export function Pop({ popKey, style, children }) {
  const v = useRef(new Animated.Value(isReduceMotionEnabled() ? 1 : 0.3)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { v.setValue(1); return undefined; }
    v.setValue(0.3);
    const a = Animated.spring(v, { toValue: 1, tension: 260, friction: 9, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [popKey, v]);
  return (
    <Animated.View style={[style, { opacity: v.interpolate({ inputRange: [0.3, 0.7, 1.2], outputRange: [0, 1, 1], extrapolate: 'clamp' }), transform: [{ scale: v }] }]}>
      {children}
    </Animated.View>
  );
}

export function TilePress({ onPress, onLongPress, delayLongPress, scaleTo = 0.9, style, children, ...rest }) {
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      scaleTo={scaleTo}
      haptic="select"
      activeOpacity={0.9}
      style={style}
      {...rest}
    >
      {children}
    </PressableScale>
  );
}
