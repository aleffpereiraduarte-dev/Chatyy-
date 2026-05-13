import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Platform } from 'react-native';

const LIVE_RED = '#dc2626';

// Humanize big counts (1.2K / 12K / 1.4M). Locale-aware separator.
function humanize(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  const sep = (() => {
    try { return (1.1).toLocaleString().includes(',') ? ',' : '.'; } catch { return '.'; }
  })();
  if (v < 10000) return (Math.floor(v / 100) / 10).toString().replace('.', sep) + 'K';
  if (v < 1_000_000) return Math.floor(v / 1000) + 'K';
  return (Math.floor(v / 100_000) / 10).toString().replace('.', sep) + 'M';
}

export default function LiveIndicator({ size = 'small', viewerCount }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.2, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ])
    );
    pulseLoop.start();
    glowLoop.start();
    return () => { pulseLoop.stop(); glowLoop.stop(); };
  }, [pulseAnim, glowAnim]);

  const isLarge = size === 'large';

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  return (
    <View style={styles.wrapper}>
      {/* Outer glow ring */}
      {isLarge && (
        <Animated.View
          style={[
            styles.glowRing,
            { opacity: glowOpacity },
          ]}
          pointerEvents="none"
        />
      )}
      <View
        style={[
          styles.badge,
          isLarge && styles.badgeLarge,
          Platform.OS === 'web' && isLarge && {
            boxShadow: '0 0 12px rgba(220, 38, 38, 0.5), 0 0 4px rgba(220, 38, 38, 0.3)',
          },
          Platform.OS === 'web' && !isLarge && {
            boxShadow: '0 0 6px rgba(220, 38, 38, 0.4)',
          },
        ]}
        accessibilityLabel="Live indicator"
      >
        <View style={[styles.dotOuter, isLarge && styles.dotOuterLarge]}>
          <Animated.View
            style={[
              styles.dot,
              isLarge && styles.dotLarge,
              { opacity: pulseAnim },
            ]}
          />
        </View>
        <Text style={[styles.text, isLarge && styles.textLarge]}>LIVE</Text>
        {viewerCount != null && (
          <View style={styles.countContainer}>
            <View style={styles.countDivider} />
            <Text style={[styles.count, isLarge && styles.countLarge]}>
              {humanize(viewerCount)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 10,
    backgroundColor: 'rgba(220, 38, 38, 0.15)',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LIVE_RED,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 5,
  },
  badgeLarge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 7,
  },
  dotOuter: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotOuterLarge: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
  dotLarge: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
  },
  textLarge: {
    fontSize: 14,
    letterSpacing: 1.2,
  },
  countContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  countDivider: {
    width: 1,
    height: 10,
    backgroundColor: 'rgba(255,255,255,0.35)',
    borderRadius: 1,
  },
  count: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 10,
    fontWeight: '700',
  },
  countLarge: {
    fontSize: 14,
  },
});
