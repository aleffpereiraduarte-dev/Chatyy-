// [2026-10-19 perf-android] Resposta única a pressão de memória.
//
// Android: pico p50 ~470 MB RSS (≈2,5× iOS), trim 40 frequente, o único crash
// nativo veio com aviso de memória — e nada no app reagia. Fontes:
//   • Android: evento onMemoryTrim do ChatyyPerf (binário com apiVersion ≥ 2;
//     o nativo já limpou o Glide). Binário antigo: só o que o SO faz sozinho.
//   • iOS: AppState 'memoryWarning'.
// Ação (no máx. 1× a cada 10 s): cache de imagem EM MEMÓRIA do expo-image
// (disco fica), conversas parseadas do chatCache (fica a aberta + 2) e o LRU
// de respostas de services/cache. registerMemoryTrimmer(fn) p/ outros caches.
// Kill switch: globalThis.__chatyy_mem_trim = false.
import { AppState, Platform } from 'react-native';

const MIN_GAP_MS = 10000;
let _started = false;
let _last = 0;
let _count = 0;
const _trimmers = new Set();

export function registerMemoryTrimmer(fn) {
  if (typeof fn !== 'function') return () => {};
  _trimmers.add(fn);
  return () => { _trimmers.delete(fn); };
}

export function getMemoryTrimStats() { return { count: _count, last: _last }; }

function _off() {
  try { return globalThis.__chatyy_mem_trim === false; } catch { return false; }
}

export function trimMemoryNow(level = 0, src = 'manual') {
  if (_off()) return false;
  const now = Date.now();
  if (now - _last < MIN_GAP_MS) return false;
  _last = now;
  _count += 1;
  try { require('expo-image').Image?.clearMemoryCache?.()?.catch?.(() => {}); } catch {} // eslint-disable-line global-require
  // fundo (≥ 40) → pode soltar todas as conversas parseadas; 1º plano → fica a aberta + 2
  const keep = level >= 40 ? 0 : 3;
  try { require('./chatCache').trimHotCache?.(keep); } catch {} // eslint-disable-line global-require
  try { require('./cache').trimMemCache?.(level >= 40 ? 0 : 50); } catch {} // eslint-disable-line global-require
  for (const fn of Array.from(_trimmers)) { try { fn(level); } catch {} }
  if (_count <= 3) {
    try { require('./crashReporter').reportStep('mem_trim', `lvl=${level} src=${src} n=${_count}`); } catch {} // eslint-disable-line global-require
  }
  return true;
}

export function startMemoryPressure() {
  if (_started || Platform.OS === 'web' || _off()) return;
  _started = true;
  if (Platform.OS === 'ios') {
    try { AppState.addEventListener('memoryWarning', () => trimMemoryNow(80, 'ios_warn')); } catch {}
    return;
  }
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core'); // eslint-disable-line global-require
    const m = typeof requireOptionalNativeModule === 'function' ? requireOptionalNativeModule('ChatyyPerf') : null;
    if (!m || typeof m.apiVersion !== 'function' || (Number(m.apiVersion()) || 0) < 2 || typeof m.addListener !== 'function') return;
    m.addListener('onMemoryTrim', (e) => {
      const lvl = Number(e && e.level) || 0;
      trimMemoryNow(lvl, 'android_trim');
    });
  } catch {}
}
