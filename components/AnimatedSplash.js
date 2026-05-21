import { useEffect, useRef, useCallback } from 'react';
import { View, Animated, Image, StyleSheet, Easing } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

// [#1239 2026-05-20] Restore Chatyy logo on the JS splash so the cold-start
// hand-off doesn't show a blank white square. The native splash image lives
// in app.json (splash-blank.png — kept blank to avoid a flash-of-native-logo)
// so we paint the logo here in JS, with a gentle scale+fade entrance and the
// existing 200ms fade-out hand-off to the real UI.
//
// [WAVE 53 2026-05-21] Adds a one-shot wink/blink on the icon right after
// it lands — same pattern as the ChatyyOneAvatar wink (close 80ms / hold
// 60ms / open 110ms). The new app icon is a face, so the blink reads as
// "the app is alive and saying hi" instead of staring blankly.
// Implemented as two small overlay bars positioned over the icon's eyes
// that scaleY from 0 → 1 → 0 in sync. Sized as a fraction of the logo so
// it scales correctly across devices.

const LOGO_SIZE = 132;
// Eye position is empirically tuned to match the new icon's face. The
// icon has its eyes at roughly y=44% of its height, with the pair centered
// horizontally and ~22px apart (relative to a 132px logo).
const EYE_TOP_FRAC = 0.42;
const EYE_OFFSET_X = 18; // half-distance between eyes, in logo px
const EYE_W = 12;
const EYE_H = 6;

export default function AnimatedSplash({ onFinish }) {
  const fadeOut = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.86)).current;
  // Eyelid scaleY: 0 = open (lid hidden), 1 = closed (lid fully drawn).
  const eyelid = useRef(new Animated.Value(0)).current;

  const onLayoutReady = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  useEffect(() => {
    // Logo entrance: scale + fade up over 280ms with a soft ease-out.
    Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(logoScale, {
        toValue: 1,
        tension: 70,
        friction: 9,
        useNativeDriver: true,
      }),
    ]).start();

    // Wink: 300ms into the splash (logo has settled), close fast (80ms),
    // hold 60ms so the closed eyes register, then open slower (110ms) for
    // a friendly "blink hello" feel. Single shot — no loop.
    Animated.sequence([
      Animated.delay(320),
      Animated.timing(eyelid, { toValue: 1, duration: 80, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay(60),
      Animated.timing(eyelid, { toValue: 0, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();

    // Hold ~900ms (entrance + blink + a beat) then fade out 220ms.
    // Was 650ms — bumped so the blink isn't cut short on slow devices.
    const timer = setTimeout(() => {
      Animated.timing(fadeOut, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => {
        onFinish?.();
      });
    }, 900);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View
      style={[s.container, { opacity: fadeOut }]}
      onLayout={onLayoutReady}
    >
      <Animated.View
        style={{
          opacity: logoOpacity,
          transform: [{ scale: logoScale }],
        }}
      >
        <Image
          source={require('../assets/icon.png')}
          style={s.logo}
          resizeMode="contain"
        />
        {/* Eyelids: two bars at eye height that "close" by scaleY 0→1.
            transformOrigin defaults to center, but for scaleY only the
            apparent close still reads as a blink at this tiny size. The
            colored matches the icon's eye-area tint so the closed lid
            blends with the face. */}
        <Animated.View
          pointerEvents="none"
          style={[
            s.eyelid,
            {
              top: LOGO_SIZE * EYE_TOP_FRAC,
              left: LOGO_SIZE / 2 - EYE_OFFSET_X - EYE_W / 2,
              transform: [{ scaleY: eyelid }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            s.eyelid,
            {
              top: LOGO_SIZE * EYE_TOP_FRAC,
              left: LOGO_SIZE / 2 + EYE_OFFSET_X - EYE_W / 2,
              transform: [{ scaleY: eyelid }],
            },
          ]}
        />
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
    zIndex: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: 28,
  },
  // Eyelid bars sit on top of the icon image. Tinted with the icon's
  // skin/face base color so the closed eye reads as part of the face
  // (matches Chatyy avatar). #2a1b3a is the dark eye/lash area of the
  // current icon; tweak alongside the icon if the art changes.
  eyelid: {
    position: 'absolute',
    width: EYE_W,
    height: EYE_H,
    borderRadius: EYE_H / 2,
    backgroundColor: '#2a1b3a',
  },
});
