import React, { useRef, useCallback } from 'react';
import { View, StyleSheet, Animated, PanResponder, Platform } from 'react-native';
import { IconTrash, IconArchive } from './Icons';

let Swipeable = null;
if (Platform.OS !== 'web') {
  try { Swipeable = require('react-native-gesture-handler').Swipeable; } catch {}
}

// Fallback PanResponder swipe for web
function PanSwipe({ children, onDelete, onArchive }) {
  const tx = useRef(new Animated.Value(0)).current;
  const pr = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderMove: Animated.event([null, { dx: tx }], {
      useNativeDriver: false,
      listener: (_, g) => {
        const clamped = Math.max(-120, Math.min(120, g.dx));
        tx.setValue(clamped);
      },
    }),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -80 && onDelete) {
        Animated.timing(tx, { toValue: -400, duration: 200, useNativeDriver: true }).start(() => { onDelete(); tx.setValue(0); });
      } else if (g.dx > 80 && onArchive) {
        Animated.timing(tx, { toValue: 400, duration: 200, useNativeDriver: true }).start(() => { onArchive(); tx.setValue(0); });
      } else {
        Animated.spring(tx, { toValue: 0, useNativeDriver: true, tension: 180, friction: 18 }).start();
      }
    },
  })).current;

  const archiveOpacity = tx.interpolate({ inputRange: [0, 60], outputRange: [0, 1], extrapolate: 'clamp' });
  const deleteOpacity = tx.interpolate({ inputRange: [-60, 0], outputRange: [1, 0], extrapolate: 'clamp' });

  return (
    <View style={{ overflow: 'hidden' }}>
      {onArchive && <Animated.View style={[s.action, { backgroundColor: '#34a853', left: 0, opacity: archiveOpacity }]}><IconArchive size={20} color="#fff" /></Animated.View>}
      {onDelete && <Animated.View style={[s.action, s.actionRight, { backgroundColor: '#ea4335', opacity: deleteOpacity }]}><IconTrash size={20} color="#fff" /></Animated.View>}
      <Animated.View style={{ transform: [{ translateX: tx }], backgroundColor: 'inherit', zIndex: 2 }} {...pr.panHandlers}>{children}</Animated.View>
    </View>
  );
}

export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  if (!Swipeable || Platform.OS === 'web') {
    return <PanSwipe onDelete={onDelete} onArchive={onArchive}>{children}</PanSwipe>;
  }
  return <NativeSwipe onDelete={onDelete} onArchive={onArchive}>{children}</NativeSwipe>;
}

function NativeSwipe({ children, onDelete, onArchive }) {
  const ref = useRef(null);

  const renderLeft = useCallback((progress, dragX) => {
    if (!onArchive) return null;
    const trans = dragX.interpolate({ inputRange: [0, 50, 100], outputRange: [-20, 0, 20], extrapolate: 'clamp' });
    const scale = dragX.interpolate({ inputRange: [0, 80], outputRange: [0.5, 1], extrapolate: 'clamp' });
    return (
      <Animated.View style={[s.nativeAction, { backgroundColor: '#34a853', transform: [{ translateX: trans }] }]}>
        <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
          <IconArchive size={22} color="#fff" />
        </Animated.View>
      </Animated.View>
    );
  }, [onArchive]);

  const renderRight = useCallback((progress, dragX) => {
    if (!onDelete) return null;
    const trans = dragX.interpolate({ inputRange: [-100, -50, 0], outputRange: [-20, 0, 20], extrapolate: 'clamp' });
    const scale = dragX.interpolate({ inputRange: [-80, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
    return (
      <Animated.View style={[s.nativeAction, { backgroundColor: '#ea4335', transform: [{ translateX: trans }] }]}>
        <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
          <IconTrash size={22} color="#fff" />
        </Animated.View>
      </Animated.View>
    );
  }, [onDelete]);

  return (
    <Swipeable
      ref={ref}
      friction={1.5}
      leftThreshold={60}
      rightThreshold={60}
      overshootLeft={false}
      overshootRight={false}
      overshootFriction={8}
      enableTrackpadTwoFingerGesture
      renderLeftActions={onArchive ? renderLeft : undefined}
      renderRightActions={onDelete ? renderRight : undefined}
      onSwipeableOpen={(d) => {
        if (d === 'left' && onArchive) onArchive();
        if (d === 'right' && onDelete) onDelete();
        setTimeout(() => ref.current?.close(), 300);
      }}
    >
      {children}
    </Swipeable>
  );
}

const s = StyleSheet.create({
  action: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', width: 90, paddingHorizontal: 12, zIndex: 1 },
  actionRight: { right: 0, left: undefined },
  nativeAction: { width: 80, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
});
