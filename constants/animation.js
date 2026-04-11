import { Platform } from 'react-native';

/**
 * React Native Web does NOT ship the RCTAnimation native module, so any
 * Animated API call with `useNativeDriver: true` logs a warning and falls
 * back to a JS-driven animation anyway.
 *
 * Import this constant everywhere instead of hardcoding `true`/`false` so
 * web builds stay clean and native builds keep their 60fps native driver.
 *
 * Usage:
 *   import { USE_NATIVE_DRIVER } from '../constants/animation';
 *   Animated.timing(val, { toValue: 1, duration: 200, useNativeDriver: USE_NATIVE_DRIVER }).start();
 */
export const USE_NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Common animation durations (milliseconds). Keep all timings consistent
 * across the app — prefer these over magic numbers.
 */
export const Duration = {
  instant: 80,
  fast: 120,
  normal: 200,
  slow: 250,
  entrance: 300,
  pageTransition: 350,
};
