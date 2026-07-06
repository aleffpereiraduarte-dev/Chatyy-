// FadeSlideIn — the canonical "screen content settles in" primitive.
//
// Why this exists: ~46 secondary screens (settings, storage, activity log,
// linked devices, starred messages…) render statically — content just
// *appears*, which reads cheap next to the chat core (which animates
// everything). Wrapping a screen's main content in <FadeSlideIn> gives it the
// same premium settle-in the ScreenEmptyState already uses (fade 420ms +
// slide-up cubic), so the whole app feels like one system on open.
//
// Usage — wrap the screen body (below the header), NOT the whole screen:
//   <FadeSlideIn>
//     <ScrollView>…</ScrollView>
//   </FadeSlideIn>
//
// For lists that render row-by-row, pass `delay` on successive sections to
// get a subtle stagger:
//   <FadeSlideIn delay={0}>{header}</FadeSlideIn>
//   <FadeSlideIn delay={60}>{list}</FadeSlideIn>
//
// Props:
//   • delay    — ms before the animation starts (default 0). Use for stagger.
//   • distance — px it slides up from (default 14). 0 = fade only.
//   • duration — fade duration ms (default 420, matches ScreenEmptyState).
//   • style    — extra style on the wrapper (it's a plain Animated.View).
//
// RN Animated only (no Reanimated) → ships via OTA. useNativeDriver:true so
// it runs on the UI thread and never jank-blocks JS.
import React, { useRef, useEffect } from 'react';
import { Animated, Easing } from 'react-native';

export default function FadeSlideIn({
  children,
  delay = 0,
  distance = 14,
  duration = 420,
  style,
}) {
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(distance)).current;

  useEffect(() => {
    const anim = Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: duration + 60,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
    // Run once on mount — deliberately no deps so re-renders don't replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[{ flex: 1, opacity: fade, transform: [{ translateY: slide }] }, style]}
    >
      {children}
    </Animated.View>
  );
}
