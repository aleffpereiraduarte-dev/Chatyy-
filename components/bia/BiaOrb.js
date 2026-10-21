// [2026-10-15 bia-design] ORB da Bia — NATIVO.
//
// Esfera monocromática "mármore líquido" (preto/grafite com brilho branco sutil):
//   • Skia (RuntimeEffect SkSL) desenhado na UI thread — o relógio vem do
//     Reanimated (useFrameCallback) e os uniforms são um useDerivedValue: ZERO
//     render React por quadro, 60 fps.
//   • mode: 'idle' (respira devagar) | 'thinking' (respira + gira mais rápido) |
//     'listening' | 'speaking' (reage ao volume via getLevel() 0..1).
//   • Reduzir Movimento → quadro estático (sem relógio).
//   • Sem Skia/Reanimated no binário (ou `lite`) → BiaOrbLite: SVG + RN Animated
//     (native driver) com o mesmo visual básico. A mesma guarda de binário do
//     studioEngine (getSkia) e do threadKeyboard (KEYBOARD_CONTROLLER_ACTIVE).
import React, { memo, useEffect, useMemo, useRef } from 'react';
import { View, Animated, Easing, Platform, TurboModuleRegistry } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle, Ellipse } from 'react-native-svg';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import { useReducedMotion } from '../reducedMotion';
import { THEME_V2 } from '../../constants/theme';

let Rea = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try { Rea = require('react-native-reanimated'); } catch { Rea = null; } // eslint-disable-line global-require
}
const REA_OK = !!(Rea && Rea.useSharedValue && Rea.useDerivedValue && Rea.useFrameCallback && Rea.withTiming);

const V2 = THEME_V2;
const MODE_ENERGY = { idle: 0.12, thinking: 0.55, listening: 0.32, speaking: 0.5 };
const MODE_NUM = { idle: 0, thinking: 1, listening: 2, speaking: 3 };

const ORB_SKSL = `
uniform float2 uCenter;
uniform float uRadius;
uniform float uTime;
uniform float uEnergy;
uniform float uDark;

float field(float2 p, float t) {
  float v = sin(p.x * 2.6 + t * 0.9 + sin(p.y * 1.9 - t * 0.6) * 1.4);
  v += sin(p.y * 3.1 - t * 0.7 + sin(p.x * 2.2 + t * 0.5) * 1.2) * 0.8;
  v += sin((p.x - p.y) * 3.7 + t * 1.3) * 0.45;
  return v / 2.25;
}

half4 main(float2 xy) {
  float2 uv = (xy - uCenter) / uRadius;
  float r = length(uv);
  float aa = 1.5 / uRadius;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  if (inside <= 0.0) { return half4(0.0); }
  float z = sqrt(max(0.0, 1.0 - r * r));
  float3 n = normalize(float3(uv, z));
  float2 w = uv / (0.55 + z * 0.75);
  float t = uTime * (0.35 + uEnergy * 0.9);
  float f = field(w * (1.2 + uEnergy * 0.35), t);
  float f2 = field(w.yx * 1.7 + 3.0, t * 1.3 + 1.7);
  float swirl = smoothstep(-0.6, 0.9, f) * 0.65 + smoothstep(-0.2, 1.0, f2) * 0.35;
  float3 L = normalize(float3(-0.45, -0.65, 0.62));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float3 rf = reflect(-L, n);
  float spec = pow(clamp(rf.z, 0.0, 1.0), 28.0);
  float rim = pow(1.0 - z, 2.4);
  float base = mix(0.035, 0.30 + uDark * 0.08, swirl);
  float c = base * (0.45 + 0.75 * diff);
  c += spec * (0.55 + 0.25 * uDark);
  c += rim * (0.22 + 0.45 * uEnergy + 0.2 * uDark);
  float band = (r - 0.82) * 7.0;
  c += exp(-band * band) * 0.06 * (0.5 + uEnergy);
  c = clamp(c, 0.0, 1.0);
  return half4(half3(c), 1.0) * half(inside);
}
`;

// Mesma guarda do studioEngine: só dá require no Skia se a ligação nativa existe
// (o NativeSetup do Skia LANÇA no require quando falta → erro fatal de módulo).
let _sk; // undefined = não sondado; null = indisponível
function getSkia() {
  if (_sk !== undefined) return _sk;
  _sk = null;
  if (Platform.OS === 'web') return null;
  try {
    let present = global.SkiaApi != null;
    if (!present) {
      try { present = !!(TurboModuleRegistry?.get && TurboModuleRegistry.get('RNSkiaModule')); } catch { present = false; }
    }
    if (!present) return null;
    const mod = require('@shopify/react-native-skia'); // eslint-disable-line global-require
    if (mod?.Skia && mod?.Canvas && mod?.Shader) _sk = mod;
  } catch { _sk = null; }
  return _sk;
}

let _effect; // undefined = não compilado; null = indisponível
function getOrbEffect(Sk) {
  if (_effect !== undefined) return _effect;
  _effect = null;
  try { _effect = Sk.Skia.RuntimeEffect.Make(ORB_SKSL) || null; } catch { _effect = null; }
  return _effect;
}

// ─── Skia + Reanimated (UI thread) ──────────────────────────────────────────
function SkiaOrb({ size, mode, getLevel, isDark, reduceMotion, paused, Sk, effect }) {
  const { Canvas, Circle: SkCircle, Shader, BlurMask } = Sk;
  const pad = Math.round(size * 0.28);
  const full = size + pad * 2;
  const c = full / 2;
  const R = size / 2;

  const clock = Rea.useSharedValue(0);
  const energy = Rea.useSharedValue(MODE_ENERGY[mode] ?? 0.12);
  const modeSV = Rea.useSharedValue(MODE_NUM[mode] ?? 0);
  const level = Rea.useSharedValue(0);
  const hasLevel = Rea.useSharedValue(getLevel ? 1 : 0);
  const darkSV = Rea.useSharedValue(isDark ? 1 : 0);

  const frame = Rea.useFrameCallback((info) => {
    'worklet';
    clock.value = info.timeSinceFirstFrame / 1000;
  }, false);
  useEffect(() => {
    try { frame.setActive(!reduceMotion && !paused); } catch {}
  }, [reduceMotion, paused, frame]);

  useEffect(() => {
    energy.value = Rea.withTiming(MODE_ENERGY[mode] ?? 0.12, { duration: 600 });
    modeSV.value = MODE_NUM[mode] ?? 0;
  }, [mode, energy, modeSV]);
  useEffect(() => { darkSV.value = isDark ? 1 : 0; }, [isDark, darkSV]);
  useEffect(() => { hasLevel.value = getLevel ? 1 : 0; }, [getLevel, hasLevel]);

  // nível de áudio: lido no JS a ~30 Hz (leitura síncrona barata) e suavizado na UI thread
  const getRef = useRef(getLevel);
  getRef.current = getLevel;
  const live = mode === 'listening' || mode === 'speaking';
  useEffect(() => {
    if (!live || !getRef.current || reduceMotion || paused) { level.value = Rea.withTiming(0, { duration: 250 }); return undefined; }
    const id = setInterval(() => {
      let v = 0;
      try { v = Number(getRef.current?.()) || 0; } catch { v = 0; }
      level.value = Rea.withTiming(Math.max(0, Math.min(1, v)), { duration: 90 });
    }, 33);
    return () => clearInterval(id);
  }, [live, reduceMotion, paused, level]);

  const geo = Rea.useDerivedValue(() => {
    const t = clock.value;
    const m = modeSV.value;
    let lv = level.value;
    if (m === 3 && hasLevel.value === 0) lv = 0.3 + 0.22 * Math.sin(t * 7.3) * Math.sin(t * 3.1);
    // [2026-10-20 grafite] "respirando": ciclo de 4 s, escala 1 → 1,03 (tema v2)
    const breath = m === 1 ? 0.045 * (0.5 + 0.5 * Math.sin(t * 2.4)) : (V2 ? 0.015 + 0.015 * Math.sin(t * 1.5708) : 0.014 * Math.sin(t * 0.9));
    const scale = 1 + breath + lv * 0.11;
    return { r: R * scale, e: energy.value + lv * 0.7, t };
  });
  const uniforms = Rea.useDerivedValue(() => ({
    uCenter: [c, c], uRadius: geo.value.r, uTime: geo.value.t, uEnergy: geo.value.e, uDark: darkSV.value,
  }));
  const shapeR = Rea.useDerivedValue(() => geo.value.r + 1);
  const glowR = Rea.useDerivedValue(() => geo.value.r * (1.02 + geo.value.e * 0.1));
  const glowOpacity = Rea.useDerivedValue(() => (darkSV.value ? 0.16 : 0.22) + geo.value.e * 0.28 + (V2 && modeSV.value === 0 ? 0.08 * (0.5 + 0.5 * Math.sin(geo.value.t * 1.5708)) : 0));

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
      <Canvas style={{ position: 'absolute', width: full, height: full, left: -pad, top: -pad }}>
        <SkCircle cx={c} cy={c} r={glowR} color={isDark ? '#FFFFFF' : '#1A1A1D'} opacity={glowOpacity}>
          <BlurMask blur={size * 0.16} style="normal" />
        </SkCircle>
        <SkCircle cx={c} cy={c} r={shapeR}>
          <Shader source={effect} uniforms={uniforms} />
        </SkCircle>
      </Canvas>
    </View>
  );
}

// ─── fallback / lite: SVG + RN Animated (native driver) ──────────────────────
let _liteSeq = 0;
export const BiaOrbLite = memo(function BiaOrbLite({ size = 40, mode = 'idle', isDark = false, animated = true, reduceMotion: rmProp }) {
  const rmHook = useReducedMotion();
  const reduceMotion = rmProp != null ? rmProp : rmHook;
  const spin = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const idRef = useRef(null);
  if (idRef.current == null) idRef.current = `bol${_liteSeq++}`;
  const id = idRef.current;
  const run = animated && !reduceMotion;
  const fast = mode === 'thinking' || mode === 'speaking';
  useEffect(() => {
    if (!run) { spin.setValue(0); breath.setValue(0); return undefined; }
    spin.setValue(0);
    const s = Animated.loop(Animated.timing(spin, { toValue: 1, duration: fast ? 3200 : 9000, easing: Easing.linear, useNativeDriver: true }));
    const b = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: fast ? 700 : (V2 ? 2000 : 2200), easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(breath, { toValue: 0, duration: fast ? 700 : (V2 ? 2000 : 2200), easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    s.start(); b.start();
    return () => { s.stop(); b.stop(); };
  }, [run, fast, spin, breath]);
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotB = spin.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });
  const scale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, fast ? 1.06 : (V2 ? 1.03 : 1.025)] });
  // [2026-10-20 grafite] brilho que acompanha a respiração (filter: brightness 1 → 1,18 do mockup)
  const glow = V2 ? breath.interpolate({ inputRange: [0, 1], outputRange: [0, 0.12] }) : null;
  const r = size / 2;
  return (
    <Animated.View
      pointerEvents="none"
      style={{ width: size, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: '#08080A', transform: [{ scale }],
        ...(isDark ? { borderWidth: Math.max(0.5, size / 90), borderColor: 'rgba(255,255,255,0.16)' } : null) }}
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <RadialGradient id={`${id}b`} cx="42%" cy="34%" r="70%">
            <Stop offset="0" stopColor="#3A3A40" />
            <Stop offset="0.6" stopColor="#141417" />
            <Stop offset="1" stopColor="#050506" />
          </RadialGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${id}b)`} />
      </Svg>
      <Animated.View style={{ position: 'absolute', width: size, height: size, transform: [{ rotate: rot }] }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id={`${id}s`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.42" />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Ellipse cx={r * 0.62} cy={r * 1.25} rx={r * 0.62} ry={r * 0.3} fill={`url(#${id}s)`} />
          <Ellipse cx={r * 1.4} cy={r * 0.7} rx={r * 0.42} ry={r * 0.22} fill={`url(#${id}s)`} opacity={0.7} />
        </Svg>
      </Animated.View>
      <Animated.View style={{ position: 'absolute', width: size, height: size, transform: [{ rotate: rotB }] }}>
        <Svg width={size} height={size}>
          <Ellipse cx={r * 1.15} cy={r * 1.45} rx={r * 0.5} ry={r * 0.18} fill={`url(#${id}s)`} opacity={0.55} />
        </Svg>
      </Animated.View>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <RadialGradient id={`${id}h`} cx="34%" cy="26%" r="34%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id={`${id}r`} cx="50%" cy="50%" r="50%">
            <Stop offset="0.78" stopColor="#FFFFFF" stopOpacity="0" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0.22" />
          </RadialGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${id}h)`} />
        <Circle cx={r} cy={r} r={r} fill={`url(#${id}r)`} />
      </Svg>
      {glow ? <Animated.View style={{ position: 'absolute', width: size, height: size, borderRadius: r, backgroundColor: '#FFFFFF', opacity: glow }} /> : null}
    </Animated.View>
  );
});

/**
 * <BiaOrb size mode getLevel isDark paused lite />
 */
function BiaOrb({ size = 120, mode = 'idle', getLevel, isDark = false, paused = false, lite = false, animated = true }) {
  const reduceMotion = useReducedMotion();
  const sk = useMemo(() => (lite || !REA_OK ? null : getSkia()), [lite]);
  const effect = sk ? getOrbEffect(sk) : null;
  if (sk && effect) {
    return <SkiaOrb size={size} mode={mode} getLevel={getLevel} isDark={isDark} reduceMotion={reduceMotion || !animated} paused={paused} Sk={sk} effect={effect} />;
  }
  return <BiaOrbLite size={size} mode={mode} isDark={isDark} animated={animated && !paused} reduceMotion={reduceMotion} />;
}

export default memo(BiaOrb);
