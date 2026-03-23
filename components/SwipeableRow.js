import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, PanResponder, Platform } from 'react-native';
import { IconTrash, IconArchive, IconBell } from './Icons';

const useNative = Platform.OS !== 'web';

export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, onSwipeLeft, onSwipeRight, colors }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const propsRef = useRef({ onDelete, onArchive, onSnooze, onSwipeLeft, onSwipeRight });
  propsRef.current = { onDelete, onArchive, onSnooze, onSwipeLeft, onSwipeRight };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => {
        return Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 2.5;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderGrant: () => {
        translateX.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        const { onArchive: hasArchive, onSwipeRight: hasRight } = propsRef.current;
        const { onDelete: hasDelete, onSwipeLeft: hasLeft } = propsRef.current;
        const canRight = !!(hasArchive || hasRight);
        const canLeft = !!(hasDelete || hasLeft);

        let val = g.dx;
        // Rubber band past 120
        if (val > 120) val = 120 + (val - 120) * 0.15;
        else if (val < -120) val = -120 + (val + 120) * 0.15;
        // Prevent wrong direction
        if (val > 0 && !canRight) val = 0;
        if (val < 0 && !canLeft) val = 0;
        translateX.setValue(val);
      },
      onPanResponderRelease: (_, g) => {
        const { onArchive, onDelete, onSwipeLeft, onSwipeRight } = propsRef.current;
        const threshold = 80;

        if (g.dx > threshold && (onArchive || onSwipeRight)) {
          // Swipe right -> archive
          Animated.timing(translateX, { toValue: 400, duration: 200, useNativeDriver: useNative }).start(() => {
            (onSwipeRight || onArchive)?.();
            setTimeout(() => { translateX.setValue(0); }, 300);
          });
        } else if (g.dx < -threshold && (onDelete || onSwipeLeft)) {
          // Swipe left -> delete
          Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: useNative }).start(() => {
            (onSwipeLeft || onDelete)?.();
            setTimeout(() => { translateX.setValue(0); }, 300);
          });
        } else {
          // Snap back
          Animated.spring(translateX, { toValue: 0, useNativeDriver: useNative, tension: 200, friction: 20 }).start();
        }
      },
    })
  ).current;

  const leftOpacity = translateX.interpolate({ inputRange: [0, 60, 80], outputRange: [0, 0.5, 1], extrapolate: 'clamp' });
  const rightOpacity = translateX.interpolate({ inputRange: [-80, -60, 0], outputRange: [1, 0.5, 0], extrapolate: 'clamp' });

  return (
    <View style={styles.container}>
      {/* Left action (archive) - shown on swipe right */}
      {(onArchive || onSwipeRight) && (
        <Animated.View style={[styles.leftAction, { opacity: leftOpacity }]}>
          <IconArchive size={22} color="#fff" />
          <Text style={styles.actionText}>Archive</Text>
        </Animated.View>
      )}
      {/* Right action (delete) - shown on swipe left */}
      {(onDelete || onSwipeLeft) && (
        <Animated.View style={[styles.rightAction, { opacity: rightOpacity }]}>
          <IconTrash size={22} color="#fff" />
          <Text style={styles.actionText}>Delete</Text>
        </Animated.View>
      )}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    position: 'relative',
  },
  leftAction: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#34a853',
    justifyContent: 'center',
    alignItems: 'center',
    width: 100,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  rightAction: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: '#ea4335',
    justifyContent: 'center',
    alignItems: 'center',
    width: 100,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  actionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
});
