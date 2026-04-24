/**
 * AnimatedStatusText
 * ------------------
 * Renders a text-only story with an optional entry animation.
 *
 * Why a dedicated component: React Native's Animated API needs its driver
 * hooks (useRef + useEffect) anchored to a stable component. Inlining this
 * inside ChatStatusTab's viewer caused the animation to re-fire on every
 * unrelated re-render (progress ticks, timer updates) because the hook
 * order changed between paths. Extracting to a component also makes it
 * trivially reusable from the profile viewer and the feed.
 *
 * Supported `animation` values: 'bounce' | 'fade' | 'typewriter' | 'none'.
 * Falls back to plain text if value is unknown — never blocks render.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

const TEXT_BASE = {
  color: '#fff',
  fontSize: 34,
  fontWeight: '700',
  textAlign: 'center',
  paddingHorizontal: 24,
};

function pickFontStyle(fontStyle) {
  if (fontStyle === 'serif') {
    return {
      fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
      fontStyle: 'italic',
    };
  }
  if (fontStyle === 'mono') {
    return { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' };
  }
  return null;
}

export default function AnimatedStatusText({
  text = '',
  bgColor = '#6D28D9',
  animation = 'none',
  fontStyle = 'normal',
  // Reset the animation whenever this key changes (e.g. status id).
  animKey = 0,
}) {
  // Bounce uses scale; fade uses opacity; typewriter uses substring length.
  const scale = useRef(new Animated.Value(animation === 'bounce' ? 0.4 : 1)).current;
  const opacity = useRef(new Animated.Value(animation === 'fade' ? 0 : 1)).current;
  const [typedLen, setTypedLen] = useState(
    animation === 'typewriter' ? 0 : text.length
  );

  useEffect(() => {
    // Reset values at the start of each run
    scale.setValue(animation === 'bounce' ? 0.4 : 1);
    opacity.setValue(animation === 'fade' ? 0 : 1);

    if (animation === 'bounce') {
      Animated.spring(scale, {
        toValue: 1,
        friction: 4,      // bounce-y
        tension: 90,
        useNativeDriver: true,
      }).start();
    } else if (animation === 'fade') {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    } else if (animation === 'typewriter') {
      setTypedLen(0);
      // Type one char every ~45ms — feels like a natural typing cadence
      // without overstaying its welcome on longer statuses.
      const total = text.length;
      const step = Math.max(20, Math.min(60, Math.floor(2500 / Math.max(total, 1))));
      let i = 0;
      const iv = setInterval(() => {
        i += 1;
        setTypedLen(i);
        if (i >= total) clearInterval(iv);
      }, step);
      return () => clearInterval(iv);
    }
    return undefined;
  }, [animKey, animation, text]);

  const display = animation === 'typewriter' ? text.slice(0, typedLen) : text;
  const caret = animation === 'typewriter' && typedLen < text.length ? '▌' : '';

  return (
    <View style={[styles.card, { backgroundColor: bgColor }]}>
      <Animated.Text
        style={[
          TEXT_BASE,
          pickFontStyle(fontStyle),
          { transform: [{ scale }], opacity },
        ]}
      >
        {display}
        {caret ? <Text style={{ opacity: 0.6 }}>{caret}</Text> : null}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
