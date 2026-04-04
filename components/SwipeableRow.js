import React, { useRef, useCallback, useMemo } from 'react';
import { View, StyleSheet, Animated, PanResponder, Platform, Easing, Text, LayoutAnimation, UIManager } from 'react-native';
import { IconTrash, IconArchive } from './Icons';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const USE_NATIVE = Platform.OS !== 'web';
const THRESHOLD = 80;

/**
 * iOS Mail-style swipe row using native-driven Animated.
 * Key: useNativeDriver=true on mobile for 60fps on the UI thread.
 * The PanResponder gesture detection still runs on JS thread,
 * but the actual animation (translateX) runs natively.
 */
export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  const tx = useRef(new Animated.Value(0)).current;
  const isAnimating = useRef(false);

  // Interpolations (these work with native driver)
  const archiveOpacity = tx.interpolate({
    inputRange: [0, 40, THRESHOLD],
    outputRange: [0, 0.5, 1],
    extrapolate: 'clamp',
  });
  const deleteOpacity = tx.interpolate({
    inputRange: [-THRESHOLD, -40, 0],
    outputRange: [1, 0.5, 0],
    extrapolate: 'clamp',
  });

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (isAnimating.current) return false;
        return Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2;
      },
      onPanResponderGrant: () => {
        tx.stopAnimation();
        tx.extractOffset();
      },
      onPanResponderMove: (_, g) => {
        // Block if no handler for that direction
        if (g.dx > 5 && !onArchive) return;
        if (g.dx < -5 && !onDelete) return;

        // Rubber-band beyond threshold
        const abs = Math.abs(g.dx);
        const sign = g.dx >= 0 ? 1 : -1;
        const val = abs < THRESHOLD
          ? sign * abs
          : sign * (THRESHOLD + (abs - THRESHOLD) * 0.2);
        tx.setValue(val);
      },
      onPanResponderRelease: (_, g) => {
        tx.flattenOffset();
        const dx = g.dx;
        const vx = g.vx;

        // Fast flick or past threshold → execute action
        if ((dx < -THRESHOLD || vx < -1.2) && onDelete) {
          isAnimating.current = true;
          Animated.timing(tx, {
            toValue: -500,
            duration: 200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: USE_NATIVE,
          }).start(() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            onDelete();
            tx.setValue(0);
            isAnimating.current = false;
          });
          return;
        }

        if ((dx > THRESHOLD || vx > 1.2) && onArchive) {
          isAnimating.current = true;
          Animated.timing(tx, {
            toValue: 500,
            duration: 200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: USE_NATIVE,
          }).start(() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            onArchive();
            tx.setValue(0);
            isAnimating.current = false;
          });
          return;
        }

        // Snap back — stiff spring for snappy feel
        Animated.spring(tx, {
          toValue: 0,
          stiffness: 500,
          damping: 35,
          mass: 0.8,
          useNativeDriver: USE_NATIVE,
        }).start();
      },
      onPanResponderTerminate: () => {
        tx.flattenOffset();
        Animated.spring(tx, {
          toValue: 0,
          stiffness: 500, damping: 35, mass: 0.8,
          useNativeDriver: USE_NATIVE,
        }).start();
      },
    })
  ).current;

  return (
    <View style={s.container}>
      {onArchive && (
        <Animated.View style={[s.bg, s.bgLeft, { opacity: archiveOpacity }]}>
          <IconArchive size={20} color="#fff" />
        </Animated.View>
      )}
      {onDelete && (
        <Animated.View style={[s.bg, s.bgRight, { opacity: deleteOpacity }]}>
          <IconTrash size={20} color="#fff" />
        </Animated.View>
      )}
      <Animated.View
        style={{ transform: [{ translateX: tx }], backgroundColor: 'inherit', zIndex: 2 }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative' },
  bg: {
    position: 'absolute', top: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
    width: 100, zIndex: 1,
  },
  bgLeft: { left: 0, backgroundColor: '#34a853' },
  bgRight: { right: 0, backgroundColor: '#ea4335' },
});
