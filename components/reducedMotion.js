// reducedMotion — single source of truth for "Reduce Motion".
//
// Why this exists: the whole app leans on motion (bubble entrances, press
// springs, nav slides, looping typing dots). Users who turn on iOS *Reduce
// Motion* / Android *Remove animations* / the web `prefers-reduced-motion`
// media query expect those to calm down — it's an accessibility requirement
// (vestibular comfort) and the App Store/Play reviewers check for it.
//
// Design: one module-level boolean = OS preference OR in-app override. Two
// ways to read it so BOTH module-scoped animation helpers and React
// components can gate:
//   • isReduceMotionEnabled()  — sync getter, for plain functions / anim setup
//   • useReducedMotion()       — hook, re-renders the component when it flips
//
// [2026-10-16 motion] In-app override (Configurações > Acessibilidade >
// "Reduzir movimento"): 'system' (padrão = segue o SO, comportamento de
// sempre) | 'on' (reduz mesmo com o SO normal). Persistido em AsyncStorage.
//   • getReduceMotionPreference() / setReduceMotionPreference('system'|'on')
//   • isSystemReduceMotionEnabled() — só o SO (p/ legenda da opção)
// Kill switches OTA:
//   • globalThis.__chatyy_motion_reduce_force = true  → força reduzir em tudo
//   • globalThis.__chatyy_motion_reduce_pref = false  → ignora o override do app
// Re-exportado por constants/motion.js (ponto único p/ telas novas).
//
// Zero native deps (AccessibilityInfo ships with react-native) → OTA-safe.
// Every call is wrapped so it can never throw on any platform.
import { useState, useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

const PREF_KEY = 'chatyy_reduce_motion_pref_v1';
let _os = false;
let _pref = 'system';
let _reduceMotion = false;
let _initialized = false;
const _subs = new Set();

function _effective() {
  let prefOn = _pref === 'on';
  try { if (globalThis.__chatyy_motion_reduce_pref === false) prefOn = false; } catch {}
  return !!(_os || prefOn);
}

function _recompute() {
  const b = _effective();
  if (b === _reduceMotion) return;
  _reduceMotion = b;
  _subs.forEach((fn) => { try { fn(b); } catch {} });
}

function _setOs(v) {
  _os = !!v;
  _recompute();
}

function _storage() {
  try {
    const m = require('@react-native-async-storage/async-storage');
    return (m && (m.default || m)) || null;
  } catch { return null; }
}

function _init() {
  if (_initialized) return;
  _initialized = true;

  // App override (async; padrão 'system' até carregar = comportamento antigo).
  try {
    const S = _storage();
    const p = S && S.getItem && S.getItem(PREF_KEY);
    if (p && typeof p.then === 'function') {
      p.then((v) => { if (v === 'on') { _pref = 'on'; _recompute(); } }).catch(() => {});
    }
  } catch {}

  // Web: honor the prefers-reduced-motion media query and track changes.
  if (Platform.OS === 'web') {
    try {
      const mq = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
      if (mq) {
        _setOs(!!mq.matches);
        const onChange = (e) => _setOs(e.matches);
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange); // Safari < 14
      }
    } catch {}
    return;
  }

  // Native: seed from the current value, then subscribe to changes.
  try {
    AccessibilityInfo.isReduceMotionEnabled?.().then(_setOs).catch(() => {});
  } catch {}
  try {
    AccessibilityInfo.addEventListener?.('reduceMotionChanged', _setOs);
  } catch {}
}
_init();

export function isReduceMotionEnabled() {
  try { if (globalThis.__chatyy_motion_reduce_force === true) return true; } catch {}
  return _reduceMotion;
}

export function isSystemReduceMotionEnabled() {
  return _os;
}

export function getReduceMotionPreference() {
  return _pref;
}

export function setReduceMotionPreference(v) {
  _pref = v === 'on' ? 'on' : 'system';
  _recompute();
  try { const S = _storage(); S && S.setItem && S.setItem(PREF_KEY, _pref).catch?.(() => {}); } catch {}
}

// [2026-10-19 a11y-complete] ouvinte fora do React (services/a11yPrefs: Reduzir
// movimento também desliga as animações da conversa / lista nativa).
export function onReduceMotionChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function useReducedMotion() {
  const [v, setV] = useState(isReduceMotionEnabled());
  useEffect(() => {
    // Re-sync in case the value changed between module init and mount.
    setV(isReduceMotionEnabled());
    _subs.add(setV);
    return () => { _subs.delete(setV); };
  }, []);
  return v;
}

export default useReducedMotion;
