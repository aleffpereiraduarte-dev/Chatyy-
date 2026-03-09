import { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Platform, Easing } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { AnimTiming } from '../constants/theme';

function Shimmer({ style, delay = 0 }) {
  const { colors } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Staggered entrance fade
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: AnimTiming.normal,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();

    // Smooth shimmer pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ])
    ).start();
  }, []);

  const bg = anim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [
      colors.borderLight || '#e5e7eb',
      colors.surfaceVariant || '#f3f4f6',
      colors.borderLight || '#e5e7eb',
    ],
  });

  const opacity = anim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.5, 0.8, 0.5],
  });

  return (
    <Animated.View
      style={[
        style,
        {
          backgroundColor: bg,
          borderRadius: 8,
          opacity: fadeAnim,
        },
      ]}
    />
  );
}

export function EmailSkeleton({ count = 6 }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <Animated.View key={i} style={s.row}>
          <Shimmer style={s.avatar} delay={i * AnimTiming.staggerFast} />
          <View style={s.lines}>
            <Shimmer style={[s.line1, { width: `${60 + Math.random() * 20}%` }]} delay={i * AnimTiming.staggerFast + 30} />
            <Shimmer style={[s.line2, { width: `${75 + Math.random() * 15}%` }]} delay={i * AnimTiming.staggerFast + 60} />
            <Shimmer style={[s.line3, { width: `${40 + Math.random() * 30}%` }]} delay={i * AnimTiming.staggerFast + 90} />
          </View>
          <Shimmer style={s.date} delay={i * AnimTiming.staggerFast + 50} />
        </Animated.View>
      ))}
    </View>
  );
}

export function MessageSkeleton() {
  return (
    <View style={s.msgContainer}>
      <Shimmer style={s.msgSubject} delay={0} />
      <View style={s.msgRow}>
        <Shimmer style={s.avatar} delay={50} />
        <View style={s.lines}>
          <Shimmer style={[s.line1, { width: '40%' }]} delay={80} />
          <Shimmer style={[s.line2, { width: '25%' }]} delay={110} />
        </View>
      </View>
      <View style={s.msgBodyBlock}>
        <Shimmer style={s.msgBody1} delay={150} />
        <Shimmer style={s.msgBody2} delay={180} />
        <Shimmer style={s.msgBody3} delay={210} />
        <Shimmer style={[s.msgBody1, { width: '85%' }]} delay={240} />
        <Shimmer style={[s.msgBody2, { width: '70%' }]} delay={270} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  lines: { flex: 1, gap: 8 },
  line1: { height: 13, width: '70%', borderRadius: 6 },
  line2: { height: 11, width: '90%', borderRadius: 6 },
  line3: { height: 10, width: '50%', borderRadius: 6, marginTop: 2 },
  date: { width: 40, height: 10, borderRadius: 5 },
  msgContainer: { padding: 20, gap: 16 },
  msgSubject: { height: 24, width: '80%', borderRadius: 8 },
  msgRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  msgBodyBlock: { gap: 10, marginTop: 8 },
  msgBody1: { height: 12, width: '100%', borderRadius: 6 },
  msgBody2: { height: 12, width: '95%', borderRadius: 6 },
  msgBody3: { height: 12, width: '60%', borderRadius: 6 },
});
