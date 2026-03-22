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

  return (
    <Animated.View
      style={[
        style,
        {
          backgroundColor: bg,
          borderRadius: 10,
          opacity: fadeAnim,
          ...(Platform.OS === 'web' ? {
            background: `linear-gradient(90deg, ${colors.borderLight || '#e5e7eb'} 25%, ${colors.surfaceVariant || '#f3f4f6'} 50%, ${colors.borderLight || '#e5e7eb'} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmerSlide 1.5s infinite ease-in-out',
          } : {}),
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

// Profile screen skeleton
export function ProfileSkeleton() {
  return (
    <View style={s.profileContainer}>
      {/* Avatar */}
      <View style={{ alignItems: 'center', paddingVertical: 24 }}>
        <Shimmer style={{ width: 108, height: 108, borderRadius: 54 }} delay={0} />
        <Shimmer style={{ width: 140, height: 18, borderRadius: 9, marginTop: 14 }} delay={50} />
        <Shimmer style={{ width: 180, height: 13, borderRadius: 7, marginTop: 8 }} delay={80} />
      </View>
      {/* Info rows */}
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={s.profileRow}>
          <Shimmer style={{ width: 36, height: 36, borderRadius: 10 }} delay={120 + i * 40} />
          <View style={{ flex: 1, gap: 6, marginLeft: 12 }}>
            <Shimmer style={{ width: 60, height: 10, borderRadius: 5 }} delay={140 + i * 40} />
            <Shimmer style={{ width: `${50 + Math.random() * 30}%`, height: 14, borderRadius: 7 }} delay={160 + i * 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Generic list skeleton (files, notes, contacts, etc.)
export function ListSkeleton({ count = 6, showIcon = true }) {
  return (
    <View style={s.container}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.row}>
          {showIcon && <Shimmer style={{ width: 40, height: 40, borderRadius: 10 }} delay={i * 40} />}
          <View style={[s.lines, { marginLeft: showIcon ? 12 : 0 }]}>
            <Shimmer style={[s.line1, { width: `${50 + Math.random() * 30}%` }]} delay={i * 40 + 20} />
            <Shimmer style={[s.line2, { width: `${30 + Math.random() * 30}%` }]} delay={i * 40 + 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Calendar skeleton
export function CalendarSkeleton() {
  return (
    <View style={s.container}>
      {/* Calendar grid placeholder */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
        <Shimmer style={{ width: 150, height: 20, borderRadius: 10, marginBottom: 16 }} delay={0} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <Shimmer key={i} style={{ width: 32, height: 12, borderRadius: 6 }} delay={i * 20} />
          ))}
        </View>
        {[0, 1, 2, 3, 4].map(row => (
          <View key={row} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
            {[0, 1, 2, 3, 4, 5, 6].map(col => (
              <Shimmer key={col} style={{ width: 32, height: 32, borderRadius: 16 }} delay={row * 30 + col * 10} />
            ))}
          </View>
        ))}
      </View>
      {/* Event list */}
      {[0, 1, 2].map(i => (
        <View key={i} style={[s.row, { paddingHorizontal: 16 }]}>
          <Shimmer style={{ width: 4, height: 40, borderRadius: 2 }} delay={200 + i * 40} />
          <View style={[s.lines, { marginLeft: 12 }]}>
            <Shimmer style={[s.line1, { width: `${40 + Math.random() * 30}%` }]} delay={220 + i * 40} />
            <Shimmer style={[s.line2, { width: `${30 + Math.random() * 20}%` }]} delay={240 + i * 40} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Grid skeleton (photos)
export function GridSkeleton({ count = 12, columns = 3 }) {
  const rows = Math.ceil(count / columns);
  return (
    <View style={s.container}>
      {Array.from({ length: rows }).map((_, row) => (
        <View key={row} style={{ flexDirection: 'row', gap: 2 }}>
          {Array.from({ length: columns }).map((_, col) => (
            <View key={col} style={{ flex: 1, aspectRatio: 1 }}>
              <Shimmer style={{ flex: 1, borderRadius: 0 }} delay={(row * columns + col) * 30} />
            </View>
          ))}
        </View>
      ))}
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
  avatar: { width: 44, height: 44, borderRadius: 22 },
  lines: { flex: 1, gap: 10 },
  line1: { height: 14, width: '70%', borderRadius: 7 },
  line2: { height: 11, width: '90%', borderRadius: 6 },
  line3: { height: 10, width: '50%', borderRadius: 6, marginTop: 2 },
  date: { width: 44, height: 10, borderRadius: 6 },
  profileContainer: { padding: 16 },
  profileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  msgContainer: { padding: 20, gap: 16 },
  msgSubject: { height: 24, width: '80%', borderRadius: 8 },
  msgRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  msgBodyBlock: { gap: 10, marginTop: 8 },
  msgBody1: { height: 12, width: '100%', borderRadius: 6 },
  msgBody2: { height: 12, width: '95%', borderRadius: 6 },
  msgBody3: { height: 12, width: '60%', borderRadius: 6 },
});
