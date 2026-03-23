import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { IconTrash, IconArchive } from './Icons';

export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  const ref = useRef(null);

  const renderLeft = useCallback((progress, dragX) => {
    if (!onArchive) return null;
    const scale = dragX.interpolate({ inputRange: [0, 80], outputRange: [0.5, 1], extrapolate: 'clamp' });
    return (
      <View style={[s.action, { backgroundColor: '#34a853' }]}>  
        <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
          <IconArchive size={22} color="#fff" />
          <Text style={s.label}>Archive</Text>
        </Animated.View>
      </View>
    );
  }, [onArchive]);

  const renderRight = useCallback((progress, dragX) => {
    if (!onDelete) return null;
    const scale = dragX.interpolate({ inputRange: [-80, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
    return (
      <View style={[s.action, s.actionRight, { backgroundColor: '#ea4335' }]}>
        <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
          <IconTrash size={22} color="#fff" />
          <Text style={s.label}>Delete</Text>
        </Animated.View>
      </View>
    );
  }, [onDelete]);

  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={80}
      rightThreshold={80}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={onArchive ? renderLeft : undefined}
      renderRightActions={onDelete ? renderRight : undefined}
      onSwipeableOpen={(dir) => {
        if (dir === 'left' && onArchive) onArchive();
        if (dir === 'right' && onDelete) onDelete();
        setTimeout(() => ref.current?.close(), 300);
      }}
    >
      {children}
    </Swipeable>
  );
}

const s = StyleSheet.create({
  action: { justifyContent: 'center', alignItems: 'center', width: 90, paddingHorizontal: 16 },
  actionRight: { alignItems: 'center' },
  label: { color: '#fff', fontWeight: '700', fontSize: 12, marginTop: 4 },
});
