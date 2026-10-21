// components/watch/WatchAmbient.js — [juntos repaginado 2026-10-21] peças visuais do mockup aprovado
// /preview-2026/juntos.html: fundo com a capa desfocada (cores da capa, como Apple Music/Spotify),
// gradiente de legibilidade, vidro, capa "respirando", ponto verde pulsante e comentários que sobem
// por cima da capa e somem. Tudo JS (expo-image/expo-blur/reanimated/svg já estão no binário) → OTA.
// Reduzir movimento: respiração e pulso param (useReducedMotion).
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Platform, Text, Animated as RNAnimated, Easing as RNEasing } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import Reanimated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, cancelAnimation, Easing } from 'react-native-reanimated';
import { useReducedMotion } from '../reducedMotion';
import { getNativeBlurView } from '../NativeBlur';

let _gid = 0;
/** Gradiente vertical por SVG (stops: [[offset 0..1, cor, opacidade]]). */
export function GradientFill({ stops, style, horizontal }) {
  const id = useRef('wg' + (++_gid)).current;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2={horizontal ? '1' : '0'} y2={horizontal ? '0' : '1'}>
            {stops.map(([o, c, a], i) => <Stop key={i} offset={String(o)} stopColor={c} stopOpacity={a == null ? 1 : a} />)}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

const READ_STOPS = [[0, '#000', 0.05], [0.6, '#000', 0.35], [1, '#000', 0.6]];
/**
 * Fundo = capa desfocada forte + saturação (Android) + escurecida + gradiente de legibilidade.
 * Sem capa: grafite escuro com leve gradiente.
 */
export function AmbientBackdrop({ uri, dim = 0.42, stops }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#17171a', overflow: 'hidden' }]}>
      {uri ? (
        <View style={[StyleSheet.absoluteFill, Platform.OS === 'android' ? { filter: [{ saturate: 1.4 }] } : null]}>
          <ExpoImage source={{ uri }} style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.5 }] }]} contentFit="cover" blurRadius={Platform.OS === 'android' ? 25 : 70} transition={250} cachePolicy="memory-disk" />
        </View>
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${dim})` }]} />
      <GradientFill stops={stops || READ_STOPS} />
    </View>
  );
}

/** Vidro: iOS = blur nativo + véu branco; demais = véu branco translúcido. */
export function Glass({ style, children, intensity = 30, veil = 0.14, pointerEvents }) {
  const BlurView = getNativeBlurView();
  return (
    <View pointerEvents={pointerEvents} style={[{ overflow: 'hidden' }, style]}>
      {BlurView ? <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${BlurView ? veil : veil + 0.04})` }]} />
      {children}
    </View>
  );
}

/** Capa "respirando" (escala 1 → 0,985 em 6 s) só tocando e sem Reduzir movimento. */
export function Breathing({ active, style, children }) {
  const reduce = useReducedMotion();
  const sc = useSharedValue(1);
  useEffect(() => {
    if (!active || reduce) { cancelAnimation(sc); sc.value = withTiming(1, { duration: 400 }); return undefined; }
    sc.value = withRepeat(withSequence(
      withTiming(0.985, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
    ), -1, false);
    return () => cancelAnimation(sc);
  }, [active, reduce, sc]);
  const as = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }] }));
  return <Reanimated.View style={[style, as]}>{children}</Reanimated.View>;
}

/** Ponto com anel pulsando (verde = no mesmo segundo; âmbar = esperando). */
export function LiveDot({ color = '#3ddc84', size = 7, pulse = true }) {
  const reduce = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (!pulse || reduce) { cancelAnimation(p); p.value = 0; return undefined; }
    p.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.out(Easing.quad) }), -1, false);
    return () => cancelAnimation(p);
  }, [pulse, reduce, p]);
  const ring = useAnimatedStyle(() => ({ opacity: p.value < 0.7 ? 0.6 * (1 - p.value / 0.7) : 0, transform: [{ scale: 1 + p.value * 2.2 }] }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Reanimated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color }, ring]} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

/** Comentário em vidro que sobe e some (4 s), por cima da capa. */
export function FloatPill({ text, name, onDone }) {
  const a = useRef(new RNAnimated.Value(0)).current;
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });
  useEffect(() => {
    RNAnimated.timing(a, { toValue: 1, duration: 4000, easing: RNEasing.linear, useNativeDriver: true })
      .start(() => { try { doneRef.current && doneRef.current(); } catch {} });
  }, [a]);
  return (
    <RNAnimated.View pointerEvents="none" style={{
      alignSelf: 'flex-end', maxWidth: 230,
      opacity: a.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 1, 0] }),
      transform: [{ translateY: a.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [10, 0, 0, -14] }) }],
    }}>
      <Glass style={st.pill} veil={0.18} intensity={24}>
        <Text style={st.pillTx} numberOfLines={2}>{name ? <Text style={{ fontWeight: '800' }}>{name} </Text> : null}{text}</Text>
      </Glass>
    </RNAnimated.View>
  );
}

const st = StyleSheet.create({
  pill: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 16 },
  pillTx: { color: '#fff', fontSize: 12.5 },
});
