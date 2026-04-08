/**
 * Haptics shim
 * ============
 * Drop-in replacement for `expo-haptics` that prefers the native Core Haptics
 * implementation from `expo-native-toolkit` (iOS) and falls back to expo-haptics
 * everywhere else. The native path uses the engine that drives WhatsApp/Apple
 * Mail haptics — sharper, lower latency, supports patterns.
 *
 * Usage (anywhere in the JS):
 *   import { tap, success, error, warning, pattern } from '../services/haptics';
 *   tap();              // light/medium impact
 *   tap('heavy');       // explicit intensity
 *   success();          // notification haptic — green check
 *   error();            // notification haptic — red X
 *   pattern([           // custom rich pattern (only iOS native)
 *     { time: 0,    intensity: 1.0, sharpness: 0.9 },
 *     { time: 0.12, intensity: 0.6, sharpness: 0.4 },
 *   ]);
 */
import { Platform } from 'react-native';

let _native = null;
if (Platform.OS === 'ios') {
  try { _native = require('../modules/expo-native-toolkit').Toolkit; } catch {}
}

let _expoHaptics = null;
try { _expoHaptics = require('expo-haptics'); } catch {}

export function tap(intensity = 'medium') {
  if (_native?.hapticImpact) {
    try { _native.hapticImpact(intensity); return; } catch {}
  }
  if (_expoHaptics?.impactAsync) {
    const map = {
      light: _expoHaptics.ImpactFeedbackStyle?.Light,
      medium: _expoHaptics.ImpactFeedbackStyle?.Medium,
      heavy: _expoHaptics.ImpactFeedbackStyle?.Heavy,
      rigid: _expoHaptics.ImpactFeedbackStyle?.Rigid,
      soft: _expoHaptics.ImpactFeedbackStyle?.Soft,
    };
    try { _expoHaptics.impactAsync(map[intensity] || map.medium); } catch {}
  }
}

export function success() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('success'); return; } catch {}
  }
  if (_expoHaptics?.notificationAsync) {
    try { _expoHaptics.notificationAsync(_expoHaptics.NotificationFeedbackType.Success); } catch {}
  }
}

export function warning() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('warning'); return; } catch {}
  }
  if (_expoHaptics?.notificationAsync) {
    try { _expoHaptics.notificationAsync(_expoHaptics.NotificationFeedbackType.Warning); } catch {}
  }
}

export function error() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('error'); return; } catch {}
  }
  if (_expoHaptics?.notificationAsync) {
    try { _expoHaptics.notificationAsync(_expoHaptics.NotificationFeedbackType.Error); } catch {}
  }
}

/**
 * Custom rich haptic pattern. Only supported by Core Haptics — silently
 * no-ops on Android or when the native module isn't loaded.
 *
 * `events` is an array of `{ time, intensity, sharpness }` where:
 *   time      — seconds offset from the start of the pattern
 *   intensity — 0..1
 *   sharpness — 0..1 (low = soft thud, high = sharp tick)
 */
export async function pattern(events) {
  if (_native?.hapticPattern) {
    try { await _native.hapticPattern(events); } catch {}
  }
}

// Convenience wrapper for the most common app moments
export const haptics = {
  buttonPress: () => tap('light'),
  toggle: () => tap('rigid'),
  send: () => pattern([
    { time: 0, intensity: 0.8, sharpness: 0.9 },
    { time: 0.06, intensity: 0.4, sharpness: 0.4 },
  ]),
  receive: () => tap('light'),
  delete: () => tap('heavy'),
  callConnect: () => success(),
  callDisconnect: () => tap('rigid'),
  error,
  warning,
  success,
};
