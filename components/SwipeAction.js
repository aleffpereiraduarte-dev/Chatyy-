import React, { useRef, useCallback } from 'react';
import { View, StyleSheet, Animated, Text } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

export default function SwipeAction({ children, onSwipeLeft, onSwipeRight, leftContent, rightContent, threshold = 60 }) {
  const ref = useRef(null);

  const renderLeft = useCallback((progress, dragX) => {
    if (!rightContent && !onSwipeRight) return null;
    const scale = dragX.interpolate({ inputRange: [0, threshold], outputRange: [0.5, 1], extrapolate: 'clamp' });
    return (
      <View style={s.bg}>
        <Animated.View style={{ transform: [{ scale }] }}>
          {rightContent || <Text style={s.text}>→</Text>}
        </Animated.View>
      </View>
    );
  }, [rightContent, onSwipeRight, threshold]);

  const renderRight = useCallback((progress, dragX) => {
    if (!leftContent && !onSwipeLeft) return null;
    const scale = dragX.interpolate({ inputRange: [-threshold, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
    return (
      <View style={[s.bg, s.bgRight]}>
        <Animated.View style={{ transform: [{ scale }] }}>
          {leftContent || <Text style={s.text}>←</Text>}
        </Animated.View>
      </View>
    );
  }, [leftContent, onSwipeLeft, threshold]);

  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={threshold}
      rightThreshold={threshold}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={onSwipeRight ? renderLeft : undefined}
      renderRightActions={onSwipeLeft ? renderRight : undefined}
      onSwipeableOpen={(dir) => {
        if (dir === 'left' && onSwipeRight) onSwipeRight();
        if (dir === 'right' && onSwipeLeft) onSwipeLeft();
        ref.current?.close();
      }}
    >
      {children}
    </Swipeable>
  );
}

const s = StyleSheet.create({
  bg: { justifyContent: 'center', paddingHorizontal: 20, width: 80 },
  bgRight: { alignItems: 'flex-end' },
  text: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
