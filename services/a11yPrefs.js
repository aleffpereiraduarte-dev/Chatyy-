// services/a11yPrefs.js — [2026-10-19 a11y-complete] FLAGS CENTRAIS de
// acessibilidade/aparência lidos pelos componentes (Ajustes › Acessibilidade e
// Aparência). Uma fonte só, legível fora do React (getters síncronos) e com
// hook (useA11y) que re-renderiza quando muda.
//
// Padrão = SISTEMA (AccessibilityInfo): Texto em negrito (iOS), Aumentar
// contraste (iOS "Escurecer cores" / Android "Texto de alto contraste" / web
// prefers-contrast) e Reduzir transparência (iOS / web). O usuário pode forçar
// 'on'/'off' por cima do sistema; 'system' volta a seguir o aparelho.
//
// Flags (efetivas):
//   boldText            texto mais forte em todo o app (services/boldText)
//   highContrast        textos secundários/divisórias mais escuros (ThemeContext) + meta das bolhas
//   reduceTransparency  sem desfoque/material de vidro (NativeBlur, barra de abas)
//   largeTargets        áreas de toque maiores (hitSlop extra em botões — services/boldText)
//   autoTranscribe      notas de voz RECEBIDAS transcritas sozinhas (legenda)
//   shapeTicks          ✓✓ lido com FORMA diferente (traço mais grosso), não só cor
//   chatMotion          "Animações da conversa" (desligado → globalThis.__chatyy_motion = false,
//                       que a conversa JS e a lista nativa já respeitam)
//   accentBubbles       balão enviado na cor do destaque (só com cor de destaque ≠ Grafite)
//   emojiSize           's' | 'm' | 'l' — tamanho dos emojis grandes (escala 0.8 / 1 / 1.2)
//
// Persistência: services/mmkv (síncrono no boot → o negrito vale já no 1º frame)
// + AsyncStorage (fallback). Preferências do APARELHO (como Reduzir movimento).
// Kill switch OTA: globalThis.__chatyy_a11y_prefs = false → tudo no padrão do sistema.
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

const KEY = 'chatyy_a11y_prefs_v1';
const TRI = new Set(['system', 'on', 'off']);
const DEFAULTS = {
  bold: 'system',
  contrast: 'system',
  transparency: 'system',
  largeTargets: false,
  autoTranscribe: false,
  shapeTicks: false,
  chatMotion: true,
  accentBubbles: false,
  emojiSize: 'm',
};
const EMOJI_SCALE = { s: 0.8, m: 1, l: 1.2 };

let _prefs = { ...DEFAULTS };
const _sys = { bold: false, contrast: false, transparency: false, screenReader: false };
let _snap = null;
let _ver = 0;
const _subs = new Set();
let _initDone = false;

function _mmkv() { try { return require('./mmkv'); } catch { return null; } }
function _as() {
  try { const m = require('@react-native-async-storage/async-storage'); return (m && (m.default || m)) || null; } catch { return null; }
}

function _sanitize(p) {
  const o = { ...DEFAULTS };
  if (!p || typeof p !== 'object') return o;
  for (const k of ['bold', 'contrast', 'transparency']) if (TRI.has(p[k])) o[k] = p[k];
  for (const k of ['largeTargets', 'autoTranscribe', 'shapeTicks', 'chatMotion', 'accentBubbles']) if (typeof p[k] === 'boolean') o[k] = p[k];
  if (EMOJI_SCALE[p.emojiSize]) o.emojiSize = p.emojiSize;
  return o;
}

function _off() { try { return globalThis.__chatyy_a11y_prefs === false; } catch { return false; } }
function _tri(k) {
  if (_off()) return !!_sys[k];
  const v = _prefs[k];
  return v === 'on' ? true : (v === 'off' ? false : !!_sys[k]);
}

function _reduceMotionApp() {
  try { return !!require('../components/reducedMotion').isReduceMotionEnabled(); } catch { return false; }
}

function _compute() {
  const p = _off() ? DEFAULTS : _prefs;
  return {
    boldText: _tri('bold'),
    highContrast: _tri('contrast'),
    reduceTransparency: _tri('transparency'),
    largeTargets: !!p.largeTargets,
    autoTranscribe: !!p.autoTranscribe,
    shapeTicks: !!p.shapeTicks,
    chatMotion: p.chatMotion !== false,
    accentBubbles: !!p.accentBubbles,
    emojiSize: p.emojiSize || 'm',
    emojiScale: EMOJI_SCALE[p.emojiSize] || 1,
    screenReader: !!_sys.screenReader,
  };
}

// "Animações da conversa" desligado (ou Reduzir movimento do app) →
// __chatyy_motion = false. Só desfazemos o que NÓS ligamos (um kill switch OTA
// que já tenha posto false continua valendo).
let _ownsMotionFlag = false;
function _syncGlobals(s) {
  try {
    globalThis.__chatyy_a11y = s;
    const wantOff = !s.chatMotion || _reduceMotionApp();
    if (wantOff) {
      if (globalThis.__chatyy_motion !== false) { globalThis.__chatyy_motion = false; _ownsMotionFlag = true; }
    } else if (_ownsMotionFlag) {
      _ownsMotionFlag = false;
      try { delete globalThis.__chatyy_motion; } catch { globalThis.__chatyy_motion = undefined; }
    }
  } catch {}
}

function _publish() {
  const s = _compute();
  const prev = _snap;
  _snap = s;
  _syncGlobals(s);
  if (prev && Object.keys(s).every((k) => prev[k] === s[k])) return;
  _ver += 1;
  _subs.forEach((fn) => { try { fn(s); } catch {} });
}

function _persist() {
  const raw = JSON.stringify(_prefs);
  try { const M = _mmkv(); M && M.setString && M.setString(KEY, raw); } catch {}
  try { const S = _as(); S && S.setItem && S.setItem(KEY, raw).catch?.(() => {}); } catch {}
}

function _sysProbe(name, getter, event) {
  try {
    const fn = AccessibilityInfo[getter];
    if (typeof fn === 'function') {
      Promise.resolve(fn.call(AccessibilityInfo)).then((v) => { if (_sys[name] !== !!v) { _sys[name] = !!v; _publish(); } }).catch(() => {});
    }
  } catch {}
  try {
    AccessibilityInfo.addEventListener?.(event, (v) => { if (_sys[name] !== !!v) { _sys[name] = !!v; _publish(); } });
  } catch {}
}

function _init() {
  if (_initDone) return;
  _initDone = true;
  // 1) síncrono (mmkv/localStorage) — 1º frame já com as preferências
  try {
    const M = _mmkv();
    const raw = M && M.getString ? M.getString(KEY) : null;
    if (raw) _prefs = _sanitize(JSON.parse(raw));
  } catch {}
  // 2) AsyncStorage (fallback se o mmkv ainda não tinha a chave)
  try {
    const S = _as();
    const p = S && S.getItem && S.getItem(KEY);
    if (p && typeof p.then === 'function') {
      p.then((raw) => {
        if (!raw) return;
        try {
          const next = _sanitize(JSON.parse(raw));
          if (JSON.stringify(next) !== JSON.stringify(_prefs)) { _prefs = next; _publish(); }
        } catch {}
      }).catch(() => {});
    }
  } catch {}
  // 3) sistema
  if (Platform.OS === 'web') {
    try {
      const mq = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
      const pairs = [['contrast', '(prefers-contrast: more)'], ['transparency', '(prefers-reduced-transparency: reduce)']];
      for (const [k, q] of pairs) {
        const m = mq(q);
        if (!m) continue;
        _sys[k] = !!m.matches;
        const on = (e) => { _sys[k] = !!e.matches; _publish(); };
        if (m.addEventListener) m.addEventListener('change', on); else if (m.addListener) m.addListener(on);
      }
    } catch {}
  } else {
    if (Platform.OS === 'ios') {
      _sysProbe('bold', 'isBoldTextEnabled', 'boldTextChanged');
      _sysProbe('contrast', 'isDarkerSystemColorsEnabled', 'darkerSystemColorsChanged');
      _sysProbe('transparency', 'isReduceTransparencyEnabled', 'reduceTransparencyChanged');
    } else {
      _sysProbe('contrast', 'isHighTextContrastEnabled', 'highTextContrastChanged');
    }
    _sysProbe('screenReader', 'isScreenReaderEnabled', 'screenReaderChanged');
  }
  // Reduzir movimento (app/SO) também desliga as animações da conversa.
  try { require('../components/reducedMotion').onReduceMotionChange?.(() => _publish()); } catch {}
  _publish();
}
_init();

// ── API ───────────────────────────────────────────────────────────────────
/** Flags efetivas (sistema + escolha do usuário). Síncrono, barato. */
export function getA11y() { return _snap || _compute(); }
/** Escolhas cruas do usuário ('system'|'on'|'off' p/ bold/contrast/transparency). */
export function getA11yPrefs() { return { ..._prefs }; }
/** Valor do SISTEMA para bold/contrast/transparency/screenReader. */
export function getSystemA11y() { return { ..._sys }; }
export function a11yVersion() { return _ver; }

export function setA11yPref(key, value) {
  if (!(key in DEFAULTS)) return;
  const next = _sanitize({ ..._prefs, [key]: value });
  if (next[key] === _prefs[key]) return;
  _prefs = next;
  _persist();
  _publish();
}

/** Para switches: liga/desliga um tri-state. Igual ao sistema → volta a 'system'. */
export function setA11yTri(key, on) {
  const sys = !!_sys[key];
  setA11yPref(key, (!!on === sys) ? 'system' : (on ? 'on' : 'off'));
}

export function subscribeA11y(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** Recalcula (ex.: depois de mudar Reduzir movimento no app). */
export function refreshA11y() { _publish(); }

export function useA11y() {
  const [s, setS] = useState(getA11y);
  useEffect(() => {
    setS(getA11y());
    return subscribeA11y(setS);
  }, []);
  return s;
}

// ── Helpers p/ consumidores ───────────────────────────────────────────────
/** Escala dos emojis grandes (conversa JS e lista nativa recebem o tamanho pronto). */
export function emojiScale() { return getA11y().emojiScale || 1; }
/** hitSlop com "Áreas de toque maiores": soma `extra` (padrão 8) ao valor dado. */
export function growHitSlop(hs, extra = 8) {
  if (hs == null) return extra;
  if (typeof hs === 'number') return hs + extra;
  if (typeof hs === 'object') {
    return {
      top: (hs.top || 0) + extra, bottom: (hs.bottom || 0) + extra,
      left: (hs.left || 0) + extra, right: (hs.right || 0) + extra,
    };
  }
  return hs;
}
/** Peso de fonte com "Texto em negrito" (undefined/normal → 600, 500 → 700 …). */
export function boldWeight(w) {
  const s = w == null ? '400' : String(w);
  switch (s) {
    case 'normal': case '400': return '600';
    case '100': case '200': case '300': return '500';
    case '500': return '700';
    case '600': return '700';
    case 'bold': case '700': return '800';
    case '800': case '900': return '900';
    default: return '600';
  }
}

export default { getA11y, getA11yPrefs, getSystemA11y, setA11yPref, setA11yTri, subscribeA11y, useA11y, refreshA11y, emojiScale, growHitSlop, boldWeight };
