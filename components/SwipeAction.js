import React, { useRef } from 'react';
import { View, Animated, PanResponder, StyleSheet, Platform } from 'react-native';

const useNative = Platform.OS !== 'web';

/**
 * Universal swipe action component using PanResponder.
 * Works on both web and native without needing react-native-gesture-handler.
 *
 * Props:
 *   onSwipeLeft   - callback when swiped left past threshold
 *   onSwipeRight  - callback when swiped right past threshold
 *   leftContent   - JSX shown behind when swiping right (left side revealed)
 *   rightContent  - JSX shown behind when swiping left (right side revealed)
 *   threshold     - px to trigger action (default 80)
 *   snapBack      - if true, snaps back after action instead of animating off (default false for left, true for right)
 *   disabled      - disables swipe
 *   style         - extra style on container
 */
export default function SwipeAction({
  children,
  onSwipeLeft,
  onSwipeRight,
  leftContent,
  rightContent,
  threshold = 80,
  snapBackLeft = false,
  snapBackRight = true,
  disabled = false,
  style,
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const propsRef = useRef({ onSwipeLeft, onSwipeRight, disabled });
  propsRef.current = { onSwipeLeft, onSwipeRight, disabled };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => {
        if (propsRef.current.disabled) return false;
        // Only activate for clearly horizontal gestures
        return Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 2.5;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderGrant: () => {
        translateX.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        // Limit the swipe range with rubber-band effect
        const maxLeft = propsRef.current.onSwipeLeft ? -180 : 0;
        const maxRight = propsRef.current.onSwipeRight ? 180 : 0;
        let val = g.dx;
        // Rubber band past limits
        if (val > 160) val = 160 + (val - 160) * 0.15;
        else if (val < -160) val = -160 + (val + 160) * 0.15;
        // Prevent wrong direction if no handler
        if (val < 0 && !propsRef.current.onSwipeLeft) val = 0;
        if (val > 0 && !propsRef.current.onSwipeRight) val = 0;
        val = Math.max(maxLeft, Math.min(maxRight, val));
        translateX.setValue(val);
      },
      onPanResponderRelease: (_, g) => {
        const { onSwipeLeft: swL, onSwipeRight: swR } = propsRef.current;
        const t = threshold;

        if (g.dx < -t && swL) {
          if (snapBackLeft) {
            // Trigger and snap back
            swL();
            Animated.spring(translateX, { toValue: 0, useNativeDriver: useNative, tension: 200, friction: 20 }).start();
          } else {
            // Animate off screen then reset
            Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: useNative }).start(() => {
              swL();
              setTimeout(() => { translateX.setValue(0); }, 300);
            });
          }
        } else if (g.dx > t && swR) {
          if (snapBackRight) {
            // Trigger and snap back (like WhatsApp reply)
            swR();
            Animated.spring(translateX, { toValue: 0, useNativeDriver: useNative, tension: 200, friction: 20 }).start();
          } else {
            // Animate off screen then reset
            Animated.timing(translateX, { toValue: 400, duration: 200, useNativeDriver: useNative }).start(() => {
              swR();
              setTimeout(() => { translateX.setValue(0); }, 300);
            });
          }
        } else {
          // Snap back
          Animated.spring(translateX, { toValue: 0, useNativeDriver: useNative, tension: 200, friction: 20 }).start();
        }
      },
    })
  ).current;

  return (
    <View style={[styles.container, style]}>
      {/* Left background (shown when swiping right) */}
      {leftContent && (
        <Animated.View style={[styles.bg, styles.bgLeft, {
          opacity: translateX.interpolate({ inputRange: [0, 60], outputRange: [0, 1], extrapolate: 'clamp' }),
        }]}>
          {leftContent}
        </Animated.View>
      )}
      {/* Right background (shown when swiping left) */}
      {rightContent && (
        <Animated.View style={[styles.bg, styles.bgRight, {
          opacity: translateX.interpolate({ inputRange: [-60, 0], outputRange: [1, 0], extrapolate: 'clamp' }),
        }]}>
          {rightContent}
        </Animated.View>
      )}
      {/* Main content */}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative' },
  bg: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 20 },
  bgLeft: { left: 0 },
  bgRight: { right: 0, alignItems: 'flex-end' },
});
