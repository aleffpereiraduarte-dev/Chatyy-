// Shared FAB primitive — Telegram-grade glass orb.
//
// Composition:
//   • brand-tinted drop shadow (extra glow under the chip)
//   • inner top highlight (white-on-brand gradient) — gives the orb feel
//   • subtle bottom shade overlay — adds depth on the lower half
//   • press-in spring scale (0.94) + press-out spring (1.0)
//   • press-bloom: brand-tinted halo that briefly expands+fades on tap
//   • haptic light tick on native press
//   • optional `pulse` halo (looped breathing ring behind the chip)
//
// Why a primitive: the app had 14 FABs each with their own shadow/scale
// recipe. This consolidates the look so future polish lands once.
import React, { useRef, useEffect, useMemo } from 'react';
import { View, TouchableOpacity, Animated, Platform, Easing } from 'react-native';

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

const tintShadow = (color, alpha = 0.42) => {
  const m = String(color || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

export default function BrandFab({
  onPress,
  onLongPress,
  delayLongPress,
  size = 56,
  radius,                 // defaults to circle (size/2)
  color = '#7C3AED',      // brand
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
    if (Platform.OS === 'web') {
      return isPrimary
        ? { boxShadow: `0 10px 28px ${tintShadow(color, 0.45)}, 0 3px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.22)` }
        : { boxShadow: '0 4px 14px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)' };
    }
    if (Platform.OS === 'ios') {
      return isPrimary
        ? { shadowColor: color, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.42, shadowRadius: 16 }
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
            overflow: 'hidden',
            ...(isGhost ? { borderWidth: 1, borderColor: borderColor || 'rgba(0,0,0,0.08)' } : null),
          },
          shadow,
        ]}
      >
        {/* Inner glass highlight — top-edge white gradient (orb feel).
            On native we use a single translucent overlay; web gets a real
            linear-gradient. Bumped to 28%/22% for a more pronounced glass
            look without going chrome-bright. */}
        {isPrimary && (
          Platform.OS === 'web' ? (
            <>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, height: r,
                  backgroundColor: 'transparent',
                  // @ts-ignore — inline web style
                  backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.04) 60%, rgba(255,255,255,0) 100%)',
                }}
              />
              {/* Bottom shade — adds depth on lower half */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  bottom: 0, left: 0, right: 0, height: Math.round(r * 0.55),
                  backgroundColor: 'transparent',
                  // @ts-ignore
                  backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0) 100%)',
                }}
              />
            </>
          ) : (
            <>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0,
                  height: Math.max(2, Math.round(r * 0.55)),
                  backgroundColor: 'rgba(255,255,255,0.22)',
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  bottom: 0, left: 0, right: 0,
                  height: Math.max(2, Math.round(r * 0.4)),
                  backgroundColor: 'rgba(0,0,0,0.10)',
                }}
              />
            </>
          )
        )}

        <Animated.View
          style={contentTransform ? { transform: contentTransform } : undefined}
        >
          {children}
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}
