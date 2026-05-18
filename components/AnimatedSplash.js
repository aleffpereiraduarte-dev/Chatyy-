import { useEffect, useRef, useCallback } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

// Minimal splash — pure white, no logo, no text, no glow.
// Just a fast fade-out hand-off to the real UI.
// User asked: tirar glow roxo + logo Chatyy + tagline + ícone do envelope.

export default function AnimatedSplash({ onFinish }) {
  const fadeOut = useRef(new Animated.Value(1)).current;

  const onLayoutReady = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  useEffect(() => {
    // Hold ~500ms (just enough for app to mount) then fade out 200ms
    const timer = setTimeout(() => {
      Animated.timing(fadeOut, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        onFinish?.();
      });
    }, 500);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View
      style={[s.container, { opacity: fadeOut }]}
      onLayout={onLayoutReady}
    />
  );
}

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
    zIndex: 999,
  },
});
