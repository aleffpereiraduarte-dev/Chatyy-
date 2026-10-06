// reducedMotion — single source of truth for the OS "Reduce Motion" preference.
//
// Why this exists: the whole app leans on motion (bubble entrances, press
// springs, nav slides, looping typing dots). Users who turn on iOS *Reduce
// Motion* / Android *Remove animations* / the web `prefers-reduced-motion`
// media query expect those to calm down — it's an accessibility requirement
// (vestibular comfort) and the App Store/Play reviewers check for it. Nothing
// in the app respected it before this module.
//
// Design: one module-level boolean kept in sync with the OS. Two ways to read
// it so BOTH module-scoped animation helpers and React components can gate:
//   • isReduceMotionEnabled()  — sync getter, for plain functions / anim setup
//   • useReducedMotion()       — hook, re-renders the component when it flips
//
// Zero native deps (AccessibilityInfo ships with react-native) → OTA-safe.
// Every call is wrapped so it can never throw on any platform.
import { useState, useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

let _reduceMotion = false;
let _initialized = false;
const _subs = new Set();

function _set(v) {
  const b = !!v;
  if (b === _reduceMotion) return;
  _reduceMotion = b;
  _subs.forEach((fn) => { try { fn(b); } catch {} });
}

function _init() {
  if (_initialized) return;
  _initialized = true;

  // Web: honor the prefers-reduced-motion media query and track changes.
  if (Platform.OS === 'web') {
    try {
      const mq = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
      if (mq) {
        _reduceMotion = !!mq.matches;
        const onChange = (e) => _set(e.matches);
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange); // Safari < 14
      }
    } catch {}
    return;
  }

  // Native: seed from the current value, then subscribe to changes.
  try {
    AccessibilityInfo.isReduceMotionEnabled?.().then(_set).catch(() => {});
  } catch {}
  try {
    AccessibilityInfo.addEventListener?.('reduceMotionChanged', _set);
  } catch {}
}
_init();

export function isReduceMotionEnabled() {
  return _reduceMotion;
}

export function useReducedMotion() {
  const [v, setV] = useState(_reduceMotion);
  useEffect(() => {
    // Re-sync in case the value changed between module init and mount.
    setV(_reduceMotion);
    _subs.add(setV);
    return () => { _subs.delete(setV); };
  }, []);
  return v;
}

export default useReducedMotion;
