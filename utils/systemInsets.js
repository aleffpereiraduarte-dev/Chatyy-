// [2026-10-07 android-native] Edge-to-edge helpers for STATIC styles.
//
// Android 15 (targetSdk 35+) enforces edge-to-edge and this app ships with
// edgeToEdgeEnabled=true (RN 0.83): every screen AND every RN <Modal> draws
// under the status bar and the navigation bar (3-button bar = 48dp, gesture
// pill ≈ 16-24dp). A lot of sheets/headers were authored as
//   paddingBottom: Platform.OS === 'ios' ? 34 : 16
// i.e. "iOS hardcodes its home-indicator area, Android has the system bars
// reserved for us" — no longer true, so the Android branch ends up under the
// nav bar (buttons unreachable on 3-button nav) or under the status bar.
//
// These helpers return the Android value + the real system-bar inset taken
// from `initialWindowMetrics` (static, synchronous — safe in StyleSheet.create
// at module scope and in class components; the app is portrait-only so the
// value doesn't change at runtime except for a nav-mode switch). They are
// ONLY meant for the Android branch of a Platform ternary; iOS keeps its
// hand-tuned values. For components that can use hooks prefer
// useSafeAreaInsets() directly.
import { Platform, StatusBar } from 'react-native';

let _metrics;
function _insets() {
  if (_metrics !== undefined) return _metrics;
  try {
    // eslint-disable-next-line global-require
    const m = require('react-native-safe-area-context').initialWindowMetrics;
    _metrics = m && m.insets ? m.insets : null;
  } catch {
    _metrics = null;
  }
  return _metrics;
}

/** Status-bar inset on Android (0 elsewhere). */
export function androidStatusInset() {
  if (Platform.OS !== 'android') return 0;
  const i = _insets();
  if (i && typeof i.top === 'number' && i.top > 0) return i.top;
  return StatusBar.currentHeight || 24;
}

/** Navigation-bar inset on Android (0 elsewhere / unknown → old behavior). */
export function androidNavInset() {
  if (Platform.OS !== 'android') return 0;
  const i = _insets();
  return i && typeof i.bottom === 'number' && i.bottom > 0 ? i.bottom : 0;
}

/**
 * Android top offset. Small values (≤28) were authored assuming the status
 * bar was reserved by the system → add the full inset. Larger values already
 * included a ~24dp status-bar allowance (translucent modals/camera) → only add
 * the excess of taller bars (punch-hole/notch devices report 32-52dp).
 */
export function androidTopInset(n) {
  const top = androidStatusInset();
  if (n <= 28) return n + top;
  return n + Math.max(0, top - 24);
}

/** Android bottom offset: value + navigation-bar inset. */
export function androidBottomInset(n) {
  return n + androidNavInset();
}
