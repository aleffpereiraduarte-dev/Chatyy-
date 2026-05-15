/**
 * AnimatedViewerCount — smooth counter for live viewer pills.
 *
 * Renders the viewer count with two animations:
 *   1. Smooth tween from previous → new count (300ms ease-out) so the number
 *      doesn't just snap when WS pushes a new value.
 *   2. Small "pulse" scale (1 → 1.1 → 1) when the count increases, matching
 *      the TikTok/Instagram bump used on +1 viewer events.
 *
 * Uses a humanized formatter:
 *   999      → "999"
 *   1000     → "1k"
 *   1500     → "1.5k"
 *   10000    → "10k"
 *   1000000  → "1M"
 *
 * Pure presentation — does NOT touch viewer-count state itself. The parent
 * still owns `count` and passes it in; this component just renders a nicer
 * version of whatever number it receives.
 *
 * Used in:
 *   - app/live-broadcast.js (top viewer pill on the host's screen)
 *   - app/live-viewer.js (viewer chip in LiveTopBar)
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

// Compact "k"/"M" formatter. Lowercase "k" (TikTok style) to differentiate
// from the older Instagram "K". Strips trailing ".0" so 1000 → "1k" not "1.0k".
export function formatCount(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(Math.floor(num));
  if (num < 1_000_000) {
    const v = num / 1000;
    const truncated = Math.floor(v * 10) / 10;
    return (truncated % 1 === 0 ? String(Math.floor(truncated)) : truncated.toFixed(1)) + 'k';
  }
  const v = num / 1_000_000;
  const truncated = Math.floor(v * 10) / 10;
  return (truncated % 1 === 0 ? String(Math.floor(truncated)) : truncated.toFixed(1)) + 'M';
}

export default function AnimatedViewerCount({ count, style }) {
  const target = Number(count) || 0;
  const prevRef = useRef(target);
  // The interpolated display number — animated from prev → target.
  const animValue = useRef(new Animated.Value(target)).current;
  const [display, setDisplay] = useState(target);
  // Pulse scale for the wrapper Text.
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const prev = prevRef.current;
    if (target === prev) return;
    prevRef.current = target;

    // Smooth tween over 300ms with ease-out so the number glides up to the
    // new value instead of snapping. Listener mirrors the animated value
    // back into React state so the Text re-renders each frame.
    animValue.stopAnimation();
    animValue.setValue(prev);
    const id = animValue.addListener(({ value }) => {
      setDisplay(value);
    });
    Animated.timing(animValue, {
      toValue: target,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      // formatCount is a JS string transform so we must drive the listener
      // on the JS thread — native driver would skip it.
      useNativeDriver: false,
    }).start(() => {
      animValue.removeListener(id);
      setDisplay(target);
    });

    // Pulse only on increase (matches IG/TikTok behavior — count going down
    // when a viewer leaves shouldn't draw attention).
    if (target > prev) {
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.1, duration: 100, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 100, useNativeDriver: true }),
      ]).start();
    }

    return () => { animValue.removeListener(id); };
  }, [target, animValue, pulse]);

  return (
    <Animated.Text style={[style, { transform: [{ scale: pulse }] }]}>
      {formatCount(display)}
    </Animated.Text>
  );
}
