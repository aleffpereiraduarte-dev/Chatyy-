// Public JS shim for `expo-live-native`. The real consumer wrapper lives in
// `services/liveNative.js` (path-imported by app screens). This file just
// re-exports the underlying native module so it's discoverable by callers
// who prefer the package-style import.
//
// import liveNative from 'expo-live-native';
//
// We deliberately do not throw if the native module is missing — Expo Go,
// web, and iOS (until the iOS module ships) all need to load this without
// crashing.

let _module = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { requireOptionalNativeModule, requireNativeModule } = require('expo-modules-core');
  if (typeof requireOptionalNativeModule === 'function') {
    _module = requireOptionalNativeModule('ExpoLiveNative');
  }
  if (_module == null && typeof requireNativeModule === 'function') {
    try {
      _module = requireNativeModule('ExpoLiveNative');
    } catch (_e) {
      _module = null;
    }
  }
} catch (_e) {
  _module = null;
}

export default _module;
