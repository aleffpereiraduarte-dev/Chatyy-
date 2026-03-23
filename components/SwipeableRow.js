import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, PanResponder, Platform } from 'react-native';
import { IconTrash, IconArchive } from './Icons';

let Swipeable = null;
try { Swipeable = require('react-native-gesture-handler').Swipeable; } catch {}

// Fallback PanResponder swipe for web (gesture-handler may not work)
function PanSwipe({ children, onDelete, onArchive }) {
  const tx = useRef(new Animated.Value(0)).current;
  const pr = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 30 && Math.abs(g.dx) > Math.abs(g.dy) * 3,
    onPanResponderMove: (_, g) => tx.setValue(Math.max(-160, Math.min(160, g.dx))),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -100 && onDelete) {
        Animated.timing(tx, { toValue: -400, duration: 200, useNativeDriver: true }).start(() => { onDelete(); tx.setValue(0); });
      } else if (g.dx > 100 && onArchive) {
        Animated.timing(tx, { toValue: 400, duration: 200, useNativeDriver: true }).start(() => { onArchive(); tx.setValue(0); });
      } else {
        Animated.spring(tx, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      }
    },
  })).current;
  return (
    <View style={{ overflow: 'hidden' }}>
      <View style={[s.action, { backgroundColor: '#34a853', left: 0 }]}><IconArchive size={20} color="#fff" /></View>
      <View style={[s.action, s.actionRight, { backgroundColor: '#ea4335', right: 0 }]}><IconTrash size={20} color="#fff" /></View>
      <Animated.View style={{ transform: [{ translateX: tx }], width: '100%', zIndex: 2 }} {...pr.panHandlers}>{children}</Animated.View>
    </View>
  );
}

export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  // Use native Swipeable on iOS/Android, PanResponder fallback on web
  if (!Swipeable || Platform.OS === 'web') {
    return <PanSwipe onDelete={onDelete} onArchive={onArchive}>{children}</PanSwipe>;
  }

  return <NativeSwipe onDelete={onDelete} onArchive={onArchive}>{children}</NativeSwipe>;
}

function NativeSwipe({ children, onDelete, onArchive }) {
  const ref = useRef(null);
  const renderLeft = useCallback((p, dx) => {
    if (!onArchive) return null;
    const scale = dx.interpolate({ inputRange: [0, 80], outputRange: [0.5, 1], extrapolate: 'clamp' });
    return <View style={s.nativeAction}><View style={[s.nativeActionInner, { backgroundColor: '#34a853' }]}><Animated.View style={{ transform: [{ scale }] }}><IconArchive size={22} color="#fff" /></Animated.View></View></View>;
  }, [onArchive]);
  const renderRight = useCallback((p, dx) => {
    if (!onDelete) return null;
    const scale = dx.interpolate({ inputRange: [-80, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
    return <View style={s.nativeAction}><View style={[s.nativeActionInner, { backgroundColor: '#ea4335' }]}><Animated.View style={{ transform: [{ scale }] }}><IconTrash size={22} color="#fff" /></Animated.View></View></View>;
  }, [onDelete]);
  return (
    <Swipeable ref={ref} friction={2} leftThreshold={80} rightThreshold={80} overshootLeft={false} overshootRight={false}
      renderLeftActions={onArchive ? renderLeft : undefined} renderRightActions={onDelete ? renderRight : undefined}
      onSwipeableOpen={(d) => { if (d==='left'&&onArchive) onArchive(); if (d==='right'&&onDelete) onDelete(); setTimeout(()=>ref.current?.close(),300); }}>
      {children}
    </Swipeable>
  );
}

const s = StyleSheet.create({
  action: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', width: 90, paddingHorizontal: 16, zIndex: 1 },
  actionRight: { right: 0, left: undefined },
  nativeAction: { width: 90, flex: 1 },
  nativeActionInner: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16 },
});
