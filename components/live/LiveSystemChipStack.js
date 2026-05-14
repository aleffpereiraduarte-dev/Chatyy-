/**
 * LiveSystemChipStack — left-bottom floating column for system events like
 * "@maria entrou", "@joao saiu". Glass chips with mini avatar + bold name +
 * body, slide-in from below with spring entrance, auto-dismiss after 4s.
 *
 * Pure presentation — parent feeds `items: [{ id, email, name, text, ts }]`,
 * and we stack the latest 4 with column-reverse so newest sits on top.
 * Each chip drives its own animated entrance/exit (no re-render storms).
 */

import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Platform, Animated,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';

const ACCENT = '#7C3AED';

function Chip({ item, onDismiss }) {
  const anim = useRef(new Animated.Value(0)).current;
  const dismissedRef = useRef(false);

  useEffect(() => {
    // Spring in
    Animated.spring(anim, {
      toValue: 1,
      friction: 7,
      tension: 130,
      useNativeDriver: true,
    }).start();

    // Auto-dismiss after 4s — fade + slide-up, then unmount.
    const t = setTimeout(() => {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      Animated.timing(anim, {
        toValue: 2,
        duration: 320,
        useNativeDriver: true,
      }).start(() => onDismiss?.(item.id));
    }, 4000);

    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.chip,
        {
          opacity: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
          transform: [{
            translateY: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [22, 0, -12] }),
          }, {
            scale: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.88, 1, 0.96] }),
          }],
        },
      ]}
    >
      <AvatarCircle name={item.name} email={item.email} size={22} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.body}>{` ${item.text}`}</Text>
      </Text>
    </Animated.View>
  );
}

export default function LiveSystemChipStack({ items = [], bottom, onDismiss }) {
  // Cap visible chips at 4 — older ones fall off the stack visually.
  const visible = items.slice(-4);
  return (
    <View
      pointerEvents="none"
      style={[styles.stack, { bottom }]}
    >
      {visible.map(it => (
        <Chip key={it.id} item={it} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    left: 12,
    gap: 6,
    zIndex: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 18,
    backgroundColor: 'rgba(124,58,237,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(196,181,253,0.45)',
    alignSelf: 'flex-start',
    maxWidth: 260,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      boxShadow: '0 2px 12px rgba(124,58,237,0.3)',
    } : {}),
  },
  text: {
    flex: 1,
    fontSize: 12,
  },
  name: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  body: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: '500',
  },
});
