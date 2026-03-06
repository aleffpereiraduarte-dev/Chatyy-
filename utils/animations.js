import { Animated, Easing, Platform } from 'react-native';

// Spring presets
export const SPRING_GENTLE = { tension: 120, friction: 14 };
export const SPRING_BOUNCY = { tension: 180, friction: 12 };
export const SPRING_SNAPPY = { tension: 300, friction: 20 };
export const SPRING_SMOOTH = { tension: 200, friction: 18 };

const nativeDriver = Platform.OS !== 'web';

// Fade in with optional delay — smoother cubic curve
export function fadeIn(animValue, duration = 300, delay = 0) {
  return Animated.timing(animValue, {
    toValue: 1,
    duration,
    delay,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: nativeDriver,
  });
}

// Fade out
export function fadeOut(animValue, duration = 200) {
  return Animated.timing(animValue, {
    toValue: 0,
    duration,
    easing: Easing.in(Easing.cubic),
    useNativeDriver: nativeDriver,
  });
}

// Slide in from direction
export function slideIn(animValue, fromValue = 50, duration = 300, delay = 0) {
  animValue.setValue(fromValue);
  return Animated.timing(animValue, {
    toValue: 0,
    duration,
    delay,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: nativeDriver,
  });
}

// Spring scale (for button press)
export function pressScale(animValue) {
  return Animated.sequence([
    Animated.spring(animValue, { toValue: 0.92, ...SPRING_SNAPPY, useNativeDriver: nativeDriver }),
    Animated.spring(animValue, { toValue: 1, ...SPRING_GENTLE, useNativeDriver: nativeDriver }),
  ]);
}

// Scale pop (for star toggle, etc.)
export function scalePop(animValue) {
  return Animated.sequence([
    Animated.spring(animValue, { toValue: 1.3, ...SPRING_BOUNCY, useNativeDriver: nativeDriver }),
    Animated.spring(animValue, { toValue: 1, ...SPRING_GENTLE, useNativeDriver: nativeDriver }),
  ]);
}

// Staggered entrance for lists
export function staggeredFadeIn(items, createAnim) {
  const animations = items.map((_, index) => {
    const anim = createAnim(index);
    return fadeIn(anim, 250, index * 50);
  });
  return Animated.stagger(50, animations);
}

// Notification slide in from top
export function slideInFromTop(translateY, opacity, duration = 350) {
  translateY.setValue(-80);
  opacity.setValue(0);
  return Animated.parallel([
    Animated.spring(translateY, { toValue: 0, ...SPRING_BOUNCY, useNativeDriver: nativeDriver }),
    fadeIn(opacity, duration),
  ]);
}

// Smooth page transition: fade + slight upward slide
export function pageEnter(opacity, translateY, delay = 0) {
  opacity.setValue(0);
  translateY.setValue(20);
  return Animated.parallel([
    Animated.timing(opacity, {
      toValue: 1, duration: 350, delay,
      easing: Easing.out(Easing.exp),
      useNativeDriver: nativeDriver,
    }),
    Animated.timing(translateY, {
      toValue: 0, duration: 400, delay,
      easing: Easing.out(Easing.exp),
      useNativeDriver: nativeDriver,
    }),
  ]);
}

// Smooth collapse/expand for accordions
export function expandCollapse(animValue, toValue, duration = 280) {
  return Animated.timing(animValue, {
    toValue,
    duration,
    easing: Easing.bezier(0.4, 0, 0.2, 1),
    useNativeDriver: false, // height animations can't use native driver
  });
}

// Micro-interaction: subtle pulse
export function pulse(animValue, scale = 1.05) {
  return Animated.sequence([
    Animated.timing(animValue, {
      toValue: scale, duration: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    }),
    Animated.timing(animValue, {
      toValue: 1, duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: nativeDriver,
    }),
  ]);
}

// Smooth spring for modals/overlays
export function modalEnter(opacity, scale) {
  opacity.setValue(0);
  scale.setValue(0.9);
  return Animated.parallel([
    Animated.timing(opacity, {
      toValue: 1, duration: 250,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    }),
    Animated.spring(scale, {
      toValue: 1, ...SPRING_SMOOTH,
      useNativeDriver: nativeDriver,
    }),
  ]);
}

export function modalExit(opacity, scale) {
  return Animated.parallel([
    Animated.timing(opacity, {
      toValue: 0, duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: nativeDriver,
    }),
    Animated.timing(scale, {
      toValue: 0.9, duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: nativeDriver,
    }),
  ]);
}

// Create animated value with initial
export function createAnimatedValue(initial = 0) {
  return new Animated.Value(initial);
}
