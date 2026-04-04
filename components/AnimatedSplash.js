import { useEffect, useRef, useCallback } from 'react';
import { View, Text, Animated, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import * as SplashScreen from 'expo-splash-screen';
import { useLanguage } from '../context/LanguageContext';

// Clean, minimal splash — Apple/Google-inspired
// White bg, logo fades in gently, single smooth motion, no clutter

export default function AnimatedSplash({ onFinish }) {
  const { t } = useLanguage();

  // Hide the native splash screen once our animated splash is laid out and visible.
  // This ensures a seamless handoff with no flash of white/icon in between.
  const onLayoutReady = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  const fadeOut = useRef(new Animated.Value(1)).current;

  // Logo
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.85)).current;
  const logoY = useRef(new Animated.Value(8)).current;

  // Text
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textY = useRef(new Animated.Value(12)).current;

  // Tagline
  const tagOpacity = useRef(new Animated.Value(0)).current;

  // Progress line
  const progressWidth = useRef(new Animated.Value(0)).current;
  const progressOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const ND = false; // Keep all animations on JS thread to avoid native driver conflicts

    // Phase 1 (0ms): Logo appears — gentle scale + fade + lift
    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 600, useNativeDriver: false }),
      Animated.spring(logoScale, { toValue: 1, tension: 80, friction: 12, useNativeDriver: false }),
      Animated.timing(logoY, { toValue: 0, duration: 600, useNativeDriver: false }),
    ]).start();

    // Phase 2 (400ms): Text fades up
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 1, duration: 500, useNativeDriver: false }),
        Animated.timing(textY, { toValue: 0, duration: 500, useNativeDriver: false }),
      ]).start();
    }, 400);

    // Phase 3 (700ms): Tagline + progress
    setTimeout(() => {
      Animated.timing(tagOpacity, { toValue: 1, duration: 400, useNativeDriver: false }).start();
      Animated.timing(progressOpacity, { toValue: 1, duration: 300, useNativeDriver: false }).start();
      Animated.timing(progressWidth, { toValue: 1, duration: 1800, useNativeDriver: false }).start();
    }, 700);

    // Fade out
    const timer = setTimeout(() => {
      Animated.timing(fadeOut, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => {
        onFinish?.();
      });
    }, 2600);

    return () => clearTimeout(timer);
  }, []);

  const progressW = progressWidth.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View style={[s.container, { opacity: fadeOut }]} onLayout={onLayoutReady}>
      {/* Logo */}
      <Animated.View style={[s.logoWrap, {
        opacity: logoOpacity,
        transform: [{ scale: logoScale }, { translateY: logoY }],
      }]}>
        <View style={s.logoBox}>
          <Svg width={44} height={44} viewBox="0 0 32 32" fill="none">
            <Rect x="2" y="6" width="28" height="20" rx="4" fill="#2563eb" opacity="0.12" />
            <Rect x="3" y="7" width="26" height="18" rx="3" stroke="#2563eb" strokeWidth="1.6" fill="none" />
            <Path d="M3 10l12.2 8.2a1.5 1.5 0 001.6 0L29 10" stroke="#2563eb" strokeWidth="1.6" strokeLinecap="round" fill="none" />
            <Circle cx="24" cy="11" r="4" fill="#2563eb" />
            <Path d="M22.3 11l1.2 1.2L25.7 10" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
      </Animated.View>

      {/* App name — single line */}
      <Animated.View style={{
        opacity: textOpacity,
        transform: [{ translateY: textY }],
        flexDirection: 'row',
        alignItems: 'baseline',
        marginTop: 20,
      }}>
        <Text style={s.title}>Chatyy</Text>
      </Animated.View>

      {/* Tagline */}
      <Animated.Text style={[s.tagline, { opacity: tagOpacity }]}>
        {t('splash.tagline')}
      </Animated.Text>

      {/* Minimal progress line */}
      <Animated.View style={[s.progressTrack, { opacity: progressOpacity }]}>
        <Animated.View style={[s.progressFill, { width: progressW }]} />
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },

  // Logo
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBox: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: '#f0f5ff',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { boxShadow: '0 2px 16px rgba(37, 99, 235, 0.12)' },
      default: {
        shadowColor: '#2563eb',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 6,
      },
    }),
  },

  // Title
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#0f172a',
    letterSpacing: -0.3,
  },
  titleAccent: {
    fontSize: 24,
    fontWeight: '600',
    color: '#2563eb',
    letterSpacing: -0.3,
  },

  // Tagline
  tagline: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 8,
    fontWeight: '400',
    letterSpacing: 0.2,
  },

  // Progress
  progressTrack: {
    width: 48,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#e2e8f0',
    marginTop: 32,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 1,
    backgroundColor: '#2563eb',
  },
});
