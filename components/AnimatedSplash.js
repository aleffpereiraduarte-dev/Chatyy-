import { useEffect, useRef, useCallback } from 'react';
import { View, Animated, Image, StyleSheet, Easing } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

// [#1239 2026-05-20] Restore Chatyy logo on the JS splash so the cold-start
// hand-off doesn't show a blank white square. The native splash image lives
// in app.json (splash-blank.png — kept blank to avoid a flash-of-native-logo)
// so we paint the logo here in JS, with a gentle scale+fade entrance and the
// existing 200ms fade-out hand-off to the real UI.

export default function AnimatedSplash({ onFinish }) {
  const fadeOut = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.86)).current;

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

    // Hold ~650ms (gives the logo a beat to settle) then fade out 220ms.
    const timer = setTimeout(() => {
      Animated.timing(fadeOut, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => {
        onFinish?.();
      });
    }, 650);

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
    width: 132,
    height: 132,
    borderRadius: 28,
  },
});
