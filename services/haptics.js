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

// [2026-10-07 native-polish] Selection tick (picker / drag-start / toggle).
// Replaces scattered `Vibration.vibrate(6..30)` calls: on iOS Vibration
// IGNORES the duration and fires the full ~400 ms system buzz, which felt
// broken next to WhatsApp's crisp ticks; on Android expo-haptics uses
// performHapticFeedback (respects the user's touch-feedback setting).
export function selection() {
  if (_expoHaptics?.selectionAsync) {
    try { _expoHaptics.selectionAsync(); return; } catch {}
  }
  tap('light');
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
    try { await _native.hapticPattern(events); return; } catch {}
  }
  // [2026-10-04] Fallback where Core Haptics patterns aren't available (Android,
  // or the native toolkit isn't loaded): approximate with a single impact so the
  // moment (e.g. "send") still gives tactile feedback instead of being MUTE.
  try { tap('medium'); } catch {}
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

// [2026-10-07 ios-native] Semantic moments — one place that decides which
// UIKit generator each interaction gets, so iOS feels like WhatsApp/Apple
// apps instead of a mix of Light/Medium/Vibration buzzes picked per screen:
//   selection  (UISelectionFeedbackGenerator) → pickers, toggles, flips, ticks
//   light/soft impact                         → small confirmations, stop
//   medium impact                             → long-press menus, hold-to-record
//   rigid impact                              → camera shutter, snap points
//   notification success/warning/error        → outcomes (sent, blocked, failed)
// Android maps the same names through expo-haptics → performHapticFeedback.
Object.assign(haptics, {
  selection,
  longPress: () => tap('medium'),
  contextMenu: () => tap('medium'),
  swipeReplyThreshold: () => tap('light'),
  shutter: () => tap('rigid'),
  recordStart: () => tap('medium'),
  recordStop: () => tap('soft'),
  recordLimitTick: () => tap('rigid'),
  pipEnter: () => tap('soft'),
  reaction: () => tap('light'),
  pullToRefresh: () => tap('soft'),
  callIncoming: () => warning(),
});
