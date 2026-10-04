// Skeleton — the canonical reusable monochrome shimmer primitive.
//
// Why this exists: loading states should read as "content is arriving", not
// "the app is stuck". A spinner on a blank plane feels slow; a shimmering
// placeholder of the SHAPE that's coming feels instant (WhatsApp / Instagram
// / Linear all do this). The app already ships a set of composite skeletons in
// SkeletonLoader.js — this file is the small BASE primitive those compose from
// and that new screens can drop in without reinventing the shimmer:
//
//   <Skeleton width={120} height={14} radius={7} />   // one shimmering bar
//   <SkeletonRow />                                    // a chat/list row
//   <SkeletonBubble side="left" lines={2} />           // a chat bubble
//
// Monochrome only — it tints itself from the theme's gray surface tokens, so
// it's automatically right in light AND dark (Uber black/white palette, zero
// color). Zero native deps: RN Animated only (opacity pulse, useNativeDriver),
// so it ships via OTA and never jank-blocks JS.
import React, { useRef, useEffect } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';

// A single shimmering block. Everything else is built from this.
//   • width / height — number (px) or string ('60%'). Default 100% × 12.
//   • radius         — border radius (default 8).
//   • delay          — ms before the pulse starts (for a subtle stagger).
//   • style          — extra style on the box.
export function Skeleton({ width = '100%', height = 12, radius = 8, delay = 0, style }) {
  const { colors } = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Gentle opacity wave — 1.4s cycle reads as "loading, fast" (matches the
    // shared Shimmer in SkeletonLoader). Sine easing so the peak feels like a
    // wave rather than a step. useNativeDriver → runs on the UI thread.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, delay, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, delay]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });
  // surfaceVariant is the neutral gray step above the page background in both
  // themes (light #F0F1F3 / dark #202022) — the correct monochrome placeholder.
  const bg = colors.surfaceVariant || colors.borderLight || '#EEE';

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: bg, opacity },
        // On web the opacity animation still runs; keep the same look.
        Platform.OS === 'web' ? { opacity } : null,
        style,
      ]}
    />
  );
}

// A list/chat-list row placeholder: round avatar + two text lines + a trailing
// meta bar. Matches the compact chat-row density.
export function SkeletonRow({ delay = 0, avatarSize = 52, style }) {
  return (
    <View style={[styles.row, style]}>
      <Skeleton width={avatarSize} height={avatarSize} radius={avatarSize / 2} delay={delay} />
      <View style={styles.rowLines}>
        <Skeleton width="55%" height={13} radius={7} delay={delay + 20} />
        <Skeleton width="80%" height={11} radius={6} delay={delay + 40} />
      </View>
      <View style={styles.rowMeta}>
        <Skeleton width={34} height={10} radius={5} delay={delay + 30} />
      </View>
    </View>
  );
}

// A chat-bubble placeholder. `side` = 'left' (received) | 'right' (sent).
export function SkeletonBubble({ side = 'left', lines = 2, width = '62%', delay = 0 }) {
  const { colors } = useTheme();
  const isRight = side === 'right';
  const bubbleBg = isRight
    ? (colors.chatBubbleOwn || colors.surfaceVariant || '#F1F3F5')
    : (colors.chatBubbleOther || colors.surface || '#FFFFFF');
  const bubbleBorder = isRight
    ? (colors.chatBubbleOwnBorder || 'rgba(17,17,17,0.06)')
    : (colors.chatBubbleOtherBorder || 'rgba(0,0,0,0.04)');
  const lineWidths = ['100%', '72%', '48%'];
  return (
    <View style={[styles.bubbleWrap, { alignSelf: isRight ? 'flex-end' : 'flex-start', width }]}>
      <View style={[styles.bubble, { backgroundColor: bubbleBg, borderColor: bubbleBorder }]}>
        {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
          <Skeleton
            key={i}
            width={lineWidths[i] || '60%'}
            height={11}
            radius={6}
            delay={delay + i * 25}
            style={i > 0 ? { marginTop: 6 } : null}
          />
        ))}
      </View>
    </View>
  );
}

// Convenience: a short stack of list rows (cold-load placeholder).
export function SkeletonRows({ count = 6, avatarSize = 52 }) {
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} delay={i * 35} avatarSize={avatarSize} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowLines: { flex: 1, gap: 8 },
  rowMeta: { alignItems: 'flex-end', gap: 8 },
  bubbleWrap: { maxWidth: 300, marginVertical: 4 },
  bubble: { borderRadius: 16, padding: 12, borderWidth: 1, overflow: 'hidden' },
});

// Crossfade helper: wrap the REAL content that replaces a skeleton so it
// fades/rises in softly instead of popping (WhatsApp/Telegram feel).
//   <SkeletonFadeIn>{rows}</SkeletonFadeIn>
export function SkeletonFadeIn({ children, duration = 240, style }) {
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(o, { toValue: 1, duration, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [o, duration]);
  const ty = o.interpolate({ inputRange: [0, 1], outputRange: [6, 0] });
  return <Animated.View style={[{ flex: 1, opacity: o, transform: [{ translateY: ty }] }, style]}>{children}</Animated.View>;
}

export default Skeleton;
