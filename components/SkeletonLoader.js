import { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';

function Shimmer({ style }) {
  const { colors } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 0, duration: 700, useNativeDriver: false }),
      ])
    ).start();
  }, []);

  const bg = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.borderLight || '#e5e7eb', colors.surfaceVariant || '#f3f4f6'],
  });

  return <Animated.View style={[style, { backgroundColor: bg, borderRadius: 8, opacity: 0.7 }]} />;
}

export function EmailSkeleton({ count = 6 }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.row}>
          <Shimmer style={s.avatar} />
          <View style={s.lines}>
            <Shimmer style={s.line1} />
            <Shimmer style={s.line2} />
          </View>
          <Shimmer style={s.date} />
        </View>
      ))}
    </View>
  );
}

export function MessageSkeleton() {
  return (
    <View style={s.msgContainer}>
      <Shimmer style={s.msgSubject} />
      <View style={s.msgRow}>
        <Shimmer style={s.avatar} />
        <View style={s.lines}>
          <Shimmer style={[s.line1, { width: '40%' }]} />
          <Shimmer style={[s.line2, { width: '25%' }]} />
        </View>
      </View>
      <Shimmer style={s.msgBody1} />
      <Shimmer style={s.msgBody2} />
      <Shimmer style={s.msgBody3} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  lines: { flex: 1, gap: 8 },
  line1: { height: 13, width: '70%' },
  line2: { height: 11, width: '90%' },
  date: { width: 40, height: 10 },
  msgContainer: { padding: 20, gap: 16 },
  msgSubject: { height: 22, width: '80%' },
  msgRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  msgBody1: { height: 12, width: '100%' },
  msgBody2: { height: 12, width: '95%' },
  msgBody3: { height: 12, width: '60%' },
});
