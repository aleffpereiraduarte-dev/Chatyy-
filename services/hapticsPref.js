// hapticsPref — preferência do usuário "Vibração ao tocar" (2026-10-16 motion).
//
// Um booleano de módulo (padrão LIGADO = comportamento de sempre) persistido
// em AsyncStorage. services/haptics.js e o helper `haptic` de constants/theme
// consultam isHapticsEnabled() antes de vibrar, então desligar aqui silencia o
// app inteiro (o que passa pelo shim). O sistema (iOS "Sons e Tátil" /
// Android "Vibração ao tocar") continua valendo por cima disso.
//
//   import { isHapticsEnabled, setHapticsEnabled, useHapticsEnabled } from '../services/hapticsPref';
//
// Kill switch OTA: globalThis.__chatyy_motion_haptics_pref = false → ignora a
// preferência (sempre vibra, como antes).
import { useEffect, useState } from 'react';

const KEY = 'chatyy_haptics_enabled_v1';
let _enabled = true;
let _loaded = false;
const _subs = new Set();

function _storage() {
  try {
    const m = require('@react-native-async-storage/async-storage');
    return (m && (m.default || m)) || null;
  } catch { return null; }
}

function _load() {
  if (_loaded) return;
  _loaded = true;
  try {
    const S = _storage();
    const p = S && S.getItem && S.getItem(KEY);
    if (p && typeof p.then === 'function') {
      p.then((v) => { if (v === '0') _apply(false); }).catch(() => {});
    }
  } catch {}
}

function _apply(v) {
  const b = !!v;
  if (b === _enabled) return;
  _enabled = b;
  _subs.forEach((fn) => { try { fn(b); } catch {} });
}

export function isHapticsEnabled() {
  _load();
  try { if (globalThis.__chatyy_motion_haptics_pref === false) return true; } catch {}
  return _enabled;
}

export function setHapticsEnabled(v) {
  _apply(v);
  try { const S = _storage(); S && S.setItem && S.setItem(KEY, v ? '1' : '0').catch?.(() => {}); } catch {}
}

export function useHapticsEnabled() {
  _load();
  const [v, setV] = useState(_enabled);
  useEffect(() => {
    setV(_enabled);
    _subs.add(setV);
    return () => { _subs.delete(setV); };
  }, []);
  return v;
}

_load();
