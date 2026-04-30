import React, { useRef } from 'react';
import { View, Animated, PanResponder, Platform } from 'react-native';

let Swipeable = null;
if (Platform.OS !== 'web') {
  try { Swipeable = require('react-native-gesture-handler').Swipeable; } catch {}
}

export default function SwipeAction({ children, onSwipeLeft, onSwipeRight, leftContent, rightContent, threshold = 60 }) {
  if (!Swipeable || Platform.OS === 'web') {
    return <PanSwipeAction onSwipeLeft={onSwipeLeft} onSwipeRight={onSwipeRight} leftContent={leftContent} rightContent={rightContent} threshold={threshold}>{children}</PanSwipeAction>;
  }
  const ref = useRef(null);
  return (
    <Swipeable ref={ref} friction={2} leftThreshold={threshold} rightThreshold={threshold} overshootLeft={false} overshootRight={false}
      renderLeftActions={onSwipeRight ? () => <View style={{ width: 80, justifyContent: 'center' }}>{leftContent}</View> : undefined}
      renderRightActions={onSwipeLeft ? () => <View style={{ width: 80, justifyContent: 'center', alignItems: 'flex-end' }}>{rightContent}</View> : undefined}
      onSwipeableOpen={(d) => { if (d==='left'&&onSwipeRight) onSwipeRight(); if (d==='right'&&onSwipeLeft) onSwipeLeft(); ref.current?.close(); }}>
      {children}
    </Swipeable>
  );
}

function PanSwipeAction({ children, onSwipeLeft, onSwipeRight, threshold }) {
  const tx = useRef(new Animated.Value(0)).current;
  const pr = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 25 && Math.abs(g.dx) > Math.abs(g.dy) * 3,
    onPanResponderMove: (_, g) => tx.setValue(Math.max(-120, Math.min(120, g.dx))),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -threshold && onSwipeLeft) { onSwipeLeft(); }
      if (g.dx > threshold && onSwipeRight) { onSwipeRight(); }
      Animated.spring(tx, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
    },
  })).current;
  return <Animated.View style={{ transform: [{ translateX: tx }] }} {...pr.panHandlers}>{children}</Animated.View>;
}
