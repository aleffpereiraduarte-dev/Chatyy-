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

// [2026-10-12 native-polish] Android: expo-haptics impactAsync/notificationAsync/
// selectionAsync drive the VIBRATOR with a waveform (buzzy, ignores the user's
// "touch feedback" setting). WhatsApp/Telegram use View.performHapticFeedback —
// the crisp, system-tuned click that also honors that setting. expo-haptics 55
// exposes it as performAndroidHapticsAsync(type). Types newer than the device
// API (confirm/reject = API 30, segment-tick = API 34) reject the promise →
// we fall back to the old vibrator path, so nothing ever goes mute.
// Kill-switch (OTA): globalThis.__chatyy_android_view_haptics = false.
const _isAndroid = Platform.OS === 'android';
function _androidHaptic(type, fallback) {
  if (!_isAndroid || globalThis.__chatyy_android_view_haptics === false
      || typeof _expoHaptics?.performAndroidHapticsAsync !== 'function') return false;
  try {
    const p = _expoHaptics.performAndroidHapticsAsync(type);
    if (p && typeof p.catch === 'function') p.catch(() => { try { fallback && fallback(); } catch {} });
    return true;
  } catch {
    return false;
  }
}
const _ANDROID_IMPACT = {
  soft: 'context-click',
  light: 'context-click',
  medium: 'virtual-key',
  heavy: 'long-press',
  rigid: 'long-press',
};

function _expoImpact(intensity) {
  if (!_expoHaptics?.impactAsync) return;
  const map = {
    light: _expoHaptics.ImpactFeedbackStyle?.Light,
    medium: _expoHaptics.ImpactFeedbackStyle?.Medium,
    heavy: _expoHaptics.ImpactFeedbackStyle?.Heavy,
    rigid: _expoHaptics.ImpactFeedbackStyle?.Rigid,
    soft: _expoHaptics.ImpactFeedbackStyle?.Soft,
  };
  try { _expoHaptics.impactAsync(map[intensity] || map.medium); } catch {}
}

function _expoNotification(kind) {
  if (!_expoHaptics?.notificationAsync) return;
  const T = _expoHaptics.NotificationFeedbackType || {};
  const v = kind === 'error' ? T.Error : kind === 'warning' ? T.Warning : T.Success;
  try { _expoHaptics.notificationAsync(v); } catch {}
}

export function tap(intensity = 'medium') {
  if (_native?.hapticImpact) {
    try { _native.hapticImpact(intensity); return; } catch {}
  }
  if (_androidHaptic(_ANDROID_IMPACT[intensity] || 'virtual-key', () => _expoImpact(intensity))) return;
  _expoImpact(intensity);
}

// [2026-10-07 native-polish] Selection tick (picker / drag-start / toggle).
// Replaces scattered `Vibration.vibrate(6..30)` calls: on iOS Vibration
// IGNORES the duration and fires the full ~400 ms system buzz, which felt
// broken next to WhatsApp's crisp ticks; on Android it goes through
// performHapticFeedback (see _androidHaptic above).
export function selection() {
  // Android: segment-tick (API 34) → clock-tick (all APIs) → vibrator.
  if (_androidHaptic('segment-tick', () => {
    if (!_androidHaptic('clock-tick', () => { try { _expoHaptics?.selectionAsync?.(); } catch {} })) {
      try { _expoHaptics?.selectionAsync?.(); } catch {}
    }
  })) return;
  if (_expoHaptics?.selectionAsync) {
    try { _expoHaptics.selectionAsync(); return; } catch {}
  }
  tap('light');
}

export function success() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('success'); return; } catch {}
  }
  if (_androidHaptic('confirm', () => _expoNotification('success'))) return;
  if (_expoHaptics?.notificationAsync) {
    try { _expoHaptics.notificationAsync(_expoHaptics.NotificationFeedbackType.Success); } catch {}
  }
}

export function warning() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('warning'); return; } catch {}
  }
  if (_androidHaptic('long-press', () => _expoNotification('warning'))) return;
  if (_expoHaptics?.notificationAsync) {
    try { _expoHaptics.notificationAsync(_expoHaptics.NotificationFeedbackType.Warning); } catch {}
  }
}

export function error() {
  if (_native?.hapticNotification) {
    try { _native.hapticNotification('error'); return; } catch {}
  }
  if (_androidHaptic('reject', () => _expoNotification('error'))) return;
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

// [2026-10-16 motion-telegram] Tabela CANÔNICA evento → intensidade (fixa).
// Telas novas devem chamar hapticEvent('nome') em vez de escolher Light/Medium
// na hora — assim a mesma ação vibra igual no app inteiro (Telegram).
//   selection : trocar aba/segmento, picker, alternar toggle, snap de folha
//   light     : toque em ação primária, reação, mostrar toast, swipe passou do limiar
//   medium    : long-press / abrir menu de contexto, segurar p/ gravar, arquivar
//   rigid     : obturador, encaixe de ponto (reordenar)
//   soft      : fechar/soltar, parar gravação, pull-to-refresh armado
//   success/warning/error : RESULTADO (enviado, bloqueado, falhou)
const EVENT_MAP = {
  tap: () => tap('light'),
  tabSwitch: selection,
  segment: selection,
  toggle: selection,
  sheetSnap: selection,
  sheetOpen: () => tap('soft'),
  sheetClose: () => tap('soft'),
  toast: () => tap('light'),
  swipeThreshold: () => tap('light'),
  reaction: () => tap('light'),
  longPress: () => tap('medium'),
  contextMenu: () => tap('medium'),
  pin: () => tap('medium'),
  archive: () => tap('medium'),
  reorderPick: () => tap('rigid'),
  reorderDrop: () => tap('soft'),
  refresh: () => tap('soft'),
  send: () => haptics.send(),
  success,
  warning,
  error,
};
Object.assign(haptics, {
  tabSwitch: EVENT_MAP.tabSwitch,
  toast: EVENT_MAP.toast,
  pin: EVENT_MAP.pin,
  archive: EVENT_MAP.archive,
  sheetSnap: EVENT_MAP.sheetSnap,
});
export function hapticEvent(name) {
  if (Platform.OS === 'web') return;
  const fn = EVENT_MAP[name] || EVENT_MAP.tap;
  try { fn(); } catch {}
}

// [2026-10-11 haptics consistency] Drop-in for `import * as Haptics from
// 'expo-haptics'` (same impactAsync / notificationAsync / selectionAsync +
// enum API) that routes through THIS shim, so screens still calling the
// expo-haptics API directly get the iOS Core Haptics engine like the rest of
// the app instead of a mix of generators. Web = silent no-op (expo-haptics on
// web rejects asynchronously → stray unhandled rejections).
//   import { HapticsCompat as Haptics } from '../services/haptics';
export const HapticsCompat = {
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy', Rigid: 'rigid', Soft: 'soft' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  impactAsync: async (style = 'medium') => {
    if (Platform.OS === 'web') return;
    tap(typeof style === 'string' ? style : 'medium');
  },
  notificationAsync: async (type = 'success') => {
    if (Platform.OS === 'web') return;
    if (type === 'error') error();
    else if (type === 'warning') warning();
    else success();
  },
  selectionAsync: async () => {
    if (Platform.OS === 'web') return;
    selection();
  },
};
