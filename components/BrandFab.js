// Shared FAB primitive.
//
// Composition ([2026-10-08 header-inset-all] chapada/monocromática):
//   • sombra neutra (preta) — sem brilho tingido, sem faixas internas
//   • default redondo (radius = size/2); posição/safe-area = quem chama
//     (use bottom: insets.bottom + 16 fora de telas com tab bar)
//   • press-in spring scale (0.94) + press-out spring (1.0)
//   • press-bloom: brand-tinted halo that briefly expands+fades on tap
//   • haptic light tick on native press
//   • optional `pulse` halo (looped breathing ring behind the chip)
//
// Why a primitive: the app had 14 FABs each with their own shadow/scale
// recipe. This consolidates the look so future polish lands once.
import React, { useRef, useEffect, useMemo } from 'react';
import { TouchableOpacity, Animated, Platform, Easing } from 'react-native';

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}


export default function BrandFab({
  onPress,
  onLongPress,
  delayLongPress,
  size = 56,
  radius,                 // defaults to circle (size/2)
  color = '#111111',      // brand
  variant = 'primary',    // 'primary' | 'secondary' | 'ghost'
  surfaceColor,           // for secondary/ghost: bg color (e.g. card)
  borderColor,            // for ghost variant
  pulse = false,          // animated breathing halo
  pulseColor,             // override (defaults to color)
  haptic = true,          // light tick on native press
  style,
  contentTransform,       // extra Animated.View transform (e.g. rotation)
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityHint,
  testID,
  children,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const bloomAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse) return undefined;
    pulseAnim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, pulseAnim]);

  const r = radius ?? size / 2;
  const isPrimary = variant === 'primary';
  const isGhost = variant === 'ghost';
  const bg = isPrimary ? color : (surfaceColor || '#fff');

  const shadow = useMemo(() => {
    // [2026-10-08 header-inset-all] Sombra NEUTRA (preta) — sombra tingida com
    // a cor da FAB virava "brilho" branco na FAB branca do modo escuro.
    if (Platform.OS === 'web') {
      return isPrimary
        ? { boxShadow: '0 6px 18px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12)' }
        : { boxShadow: '0 4px 14px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)' };
    }
    if (Platform.OS === 'ios') {
      return isPrimary
        ? { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.24, shadowRadius: 12 }
        : { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.14, shadowRadius: 8 };
    }
    return { elevation: isPrimary ? 10 : 4 };
  }, [color, isPrimary]);

  const handlePressIn = () => {
    Animated.spring(scale, { toValue: 0.94, useNativeDriver: true, friction: 7, tension: 220 }).start();
    // Press bloom: ring expands + fades behind the orb
    bloomAnim.setValue(0);
    Animated.timing(bloomAnim, { toValue: 1, duration: 480, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    // Haptic on native press (light tick)
    if (haptic && Platform.OS !== 'web' && _Haptics?.impactAsync) {
      try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
    }
  };
  const handlePressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 5, tension: 180 }).start();
  };

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: r,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'transparent',
          transform: [{ scale }],
        },
        style,
      ]}
      pointerEvents="box-none"
    >
      {/* Pulse halo — sits behind the orb, breathes outward */}
      {pulse && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: r,
            backgroundColor: pulseColor || color,
            opacity: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.34, 0] }),
            transform: [{ scale: pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
          }}
        />
      )}

      {/* Press bloom — fires on every tap, brand-tinted ring expands+fades */}
      {isPrimary && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: r,
            backgroundColor: color,
            opacity: bloomAnim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.28, 0] }),
            transform: [{ scale: bloomAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
          }}
        />
      )}

      <TouchableOpacity
        activeOpacity={0.92}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={[
          {
            width: size,
            height: size,
            borderRadius: r,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: bg,
            // sem overflow:'hidden' — no iOS ele recortava a própria sombra
            ...(isGhost ? { borderWidth: 1, borderColor: borderColor || 'rgba(0,0,0,0.08)' } : null),
          },
          shadow,
        ]}
      >
        {/* [2026-10-08 header-inset-all] SEM faixas de "vidro" internas. No
            nativo eram dois Views SÓLIDOS (branco 22% no topo / preto 10% na
            base) recortados pelo overflow → numa FAB quadrada (radius 16) ou
            preta/branca viravam uma FAIXA visível no topo (print do founder em
            /documentos). FAB agora é chapada, monocromática, como o resto do app. */}
        <Animated.View
          style={contentTransform ? { transform: contentTransform } : undefined}
        >
          {children}
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}
