import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, I18nManager } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { IconTrash, IconArchive, IconBell } from './Icons';

export default function SwipeableRow({ children, onDelete, onArchive, onSnooze, colors }) {
  const swipeableRef = useRef(null);

  const close = useCallback(() => {
    swipeableRef.current?.close();
  }, []);

  const renderLeftActions = useCallback((progress, dragX) => {
    if (!onArchive) return null;
    const trans = dragX.interpolate({ inputRange: [0, 80, 120], outputRange: [-20, 0, 20], extrapolate: 'clamp' });
    const opacity = dragX.interpolate({ inputRange: [0, 60, 80], outputRange: [0, 0.5, 1], extrapolate: 'clamp' });
    return (
      <Animated.View style={[styles.leftAction, { opacity, transform: [{ translateX: trans }] }]}>
        <IconArchive size={22} color="#fff" />
        <Text style={styles.actionText}>Archive</Text>
      </Animated.View>
    );
  }, [onArchive]);

  const renderRightActions = useCallback((progress, dragX) => {
    if (!onDelete) return null;
    const trans = dragX.interpolate({ inputRange: [-120, -80, 0], outputRange: [-20, 0, 20], extrapolate: 'clamp' });
    const opacity = dragX.interpolate({ inputRange: [-80, -60, 0], outputRange: [1, 0.5, 0], extrapolate: 'clamp' });
    return (
      <Animated.View style={[styles.rightAction, { opacity, transform: [{ translateX: trans }] }]}>
        <IconTrash size={22} color="#fff" />
        <Text style={styles.actionText}>Delete</Text>
      </Animated.View>
    );
  }, [onDelete]);

  return (
    <Swipeable
      ref={swipeableRef}
      friction={2}
      leftThreshold={80}
      rightThreshold={80}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={onArchive ? renderLeftActions : undefined}
      renderRightActions={onDelete ? renderRightActions : undefined}
      onSwipeableOpen={(direction) => {
        if (direction === 'left' && onArchive) { onArchive(); }
        if (direction === 'right' && onDelete) { onDelete(); }
        setTimeout(() => close(), 300);
      }}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  leftAction: {
    backgroundColor: '#34a853',
    justifyContent: 'center',
    alignItems: 'center',
    width: 100,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  rightAction: {
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
