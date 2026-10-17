// constants/motion.js — TOKENS DE MOVIMENTO do Chatyy (2026-10-16, "nível Telegram").
// ═════════════════════════════════════════════════════════════════════════
// Uma fonte só p/ molas, durações, escalas de toque, distâncias, limiares de
// gesto, haptics e Reduzir Movimento. Primitivos (PressableScale, FadeSlideIn,
// Sheet, Toast, SegmentedControl, Badge, RollingNumber, NativeSwitch, Skeleton)
// já consomem daqui. Telas novas: NUNCA número mágico de tension/friction.
//
//   import { Springs, Durations, PressScale, Distances, Gestures,
//            springTo, timingTo, motionEnabled, useMotion,
//            useReducedMotion, isReduceMotionEnabled, feedback } from '../constants/motion';
//
//   springTo(anim, 1, 'snappy').start();          // RN Animated (respeita Reduzir Movimento)
//   withSpring(1, Springs.snappy)                 // Reanimated (mesmo objeto)
//   feedback.selection();                          // haptic (respeita a preferência do usuário)
//
// MOLAS: objetos { stiffness, damping, mass } — aceitos IGUAIS por
// Animated.spring (RN) e withSpring (Reanimated). As que já existiam no app
// (tension/friction "origami") foram convertidas pela MESMA fórmula que o RN
// usa internamente (stiffness = (t-30)*3.62+194, damping = (f-8)*3+25) →
// física idêntica, zero mudança de comportamento.
//
// KILL SWITCHES OTA (globalThis):
//   __chatyy_motion_all = false          → desliga TODA animação baseada nestes
//                                          helpers (age como Reduzir Movimento)
//   __chatyy_motion_<feature> = false    → desliga uma feature (motionEnabled('feature')):
//        sheet_drag (folha: arrastar o painel inteiro + fundo proporcional),
//        toast_swipe (toast: arrastar p/ o lado), toast_spring (saída por mola),
//        empty_state (entrada de estado vazio), skeleton_fade
//   __chatyy_motion_reduce_force = true  → força Reduzir Movimento
//   __chatyy_motion_reduce_pref = false  → ignora o override do app (só o SO)
//   __chatyy_motion_haptics_pref = false → ignora "Vibração ao tocar" (sempre vibra)
// ═════════════════════════════════════════════════════════════════════════
import { Animated, Easing, LayoutAnimation, Platform } from 'react-native';
import { Overlay } from './theme';
import {
  isReduceMotionEnabled,
  useReducedMotion,
  isSystemReduceMotionEnabled,
  getReduceMotionPreference,
  setReduceMotionPreference,
} from '../components/reducedMotion';
import { isHapticsEnabled, setHapticsEnabled, useHapticsEnabled } from '../services/hapticsPref';

export {
  isReduceMotionEnabled, useReducedMotion, isSystemReduceMotionEnabled,
  getReduceMotionPreference, setReduceMotionPreference,
  isHapticsEnabled, setHapticsEnabled, useHapticsEnabled,
};

export const USE_NATIVE_DRIVER = Platform.OS !== 'web';

// origami (tension/friction) → física { stiffness, damping, mass } (fórmula do RN).
export function fromOrigami(tension, friction) {
  return {
    stiffness: Math.round(((tension - 30) * 3.62 + 194) * 10) / 10,
    damping: (friction - 8) * 3 + 25,
    mass: 1,
  };
}

// ── Molas nomeadas ─────────────────────────────────────────────────────────
// ζ = damping / (2·√(stiffness·mass)). <1 = passa um pouco e volta; ≥1 = sem pulo.
export const Springs = {
  // Semânticas (use estas em código novo)
  snappy: { stiffness: 520, damping: 40, mass: 1 },   // ζ≈0.88 — indicadores, chips, toggles, retorno de arrasto
  gentle: { stiffness: 180, damping: 24, mass: 1 },   // ζ≈0.89 — entradas grandes, cards, estados vazios
  bouncy: { stiffness: 300, damping: 16, mass: 1 },   // ζ≈0.46 — "pop" de celebração (sucesso, curtida)
  sheet: { ...Overlay.spring },                       // ζ≈0.89 — folhas/toasts (= Overlay.spring)
  // Primitivos existentes (valores convertidos, idênticos ao que já rodava)
  press: fromOrigami(340, 12),        // PressableScale press-in
  release: fromOrigami(220, 13),      // PressableScale soltar
  segment: fromOrigami(260, 26),      // SegmentedControl pílula
  toggle: fromOrigami(260, 22),       // NativeSwitch (web) knob
  digit: fromOrigami(220, 22),        // RollingNumber colunas
  pop: fromOrigami(340, 11),          // Badge "bump" 1.18→1
};

// ── Durações (ms) ──────────────────────────────────────────────────────────
export const Durations = {
  instant: 100,
  fast: 150,
  base: 200,
  slow: 260,
  page: 320,
  enter: Overlay.enterMs,   // 200 — fade de fundo de folha/toast
  exit: Overlay.exitMs,     // 180 — saída de folha/toast
  fadeIn: 220,              // FadeSlideIn
  skeletonFade: 240,        // SkeletonFadeIn
  toast: 3500,
  toastWithAction: 5000,
};

// Curvas p/ Animated.timing (nunca Easing.linear em UI — só em loops contínuos).
export const Easings = {
  standard: Easing.bezier(0.2, 0, 0, 1),
  decelerate: Easing.out(Easing.cubic),
  accelerate: Easing.in(Easing.cubic),
  fadeIn: Easing.out(Easing.quad),
  fadeOut: Easing.in(Easing.quad),
};

// ── Escalas de toque ───────────────────────────────────────────────────────
export const PressScale = {
  default: 0.97,   // botões / cards (PressableScale padrão)
  icon: 0.92,      // botões de ícone pequenos
  chip: 0.95,      // chips / pílulas
  card: 0.98,      // superfícies grandes
};

// ── Distâncias (px) ────────────────────────────────────────────────────────
export const Distances = {
  enter: 10,       // FadeSlideIn
  skeleton: 6,     // SkeletonFadeIn
  toast: 24,       // toast sobe de +24
  emptyState: 12,  // estado vazio
};

// ── Limiares de gesto ──────────────────────────────────────────────────────
export const Gestures = {
  sheetDismissDistance: 96,    // px arrastados p/ fechar a folha
  sheetDismissVelocity: 0.9,   // px/ms (PanResponder vy)
  sheetRubberBand: 0.55,       // resistência ao puxar p/ cima
  toastDismissDistance: 30,
  toastDismissVelocity: 0.6,
  toastSwipeX: 80,             // arrastar p/ o lado dispensa
  toastSwipeVx: 0.7,
};

// ── Gate único ─────────────────────────────────────────────────────────────
export function motionEnabled(feature) {
  if (isReduceMotionEnabled()) return false;
  try {
    if (globalThis.__chatyy_motion_all === false) return false;
    if (feature && globalThis['__chatyy_motion_' + feature] === false) return false;
  } catch {}
  return true;
}

function _spring(name) {
  if (!name) return Springs.snappy;
  if (typeof name === 'object') return name;
  return Springs[name] || Springs.snappy;
}

// Animated.spring com token; com movimento desligado vira um "set" instantâneo
// (mesma API: devolve CompositeAnimation, chame .start()).
export function springTo(value, toValue, spring = 'snappy', opts = {}) {
  const { feature, ...rest } = opts || {};
  const useNativeDriver = rest.useNativeDriver != null ? rest.useNativeDriver : USE_NATIVE_DRIVER;
  if (!motionEnabled(feature)) {
    return Animated.timing(value, { toValue, duration: 0, useNativeDriver });
  }
  return Animated.spring(value, { toValue, ..._spring(spring), ...rest, useNativeDriver });
}

// Animated.timing com token de duração + curva (padrão decelerate).
export function timingTo(value, toValue, duration = 'base', opts = {}) {
  const { feature, ...rest } = opts || {};
  const useNativeDriver = rest.useNativeDriver != null ? rest.useNativeDriver : USE_NATIVE_DRIVER;
  const ms = typeof duration === 'number' ? duration : (Durations[duration] ?? Durations.base);
  return Animated.timing(value, {
    toValue,
    duration: motionEnabled(feature) ? ms : 0,
    easing: Easings.decelerate,
    ...rest,
    useNativeDriver,
  });
}

// LayoutAnimation com token (expandir/recolher, mostrar campo Cc/Cco…):
// 'spring' (padrão: altura com mola amortecida + fade de entrada/saída) |
// 'ease' (preset easeInEaseOut antigo). Com movimento desligado não anima
// (troca seca). Kill: __chatyy_motion_layout = false → volta ao preset 'ease'.
const _LAYOUT_SPRING = {
  duration: 280,
  create: { type: 'easeInEaseOut', property: 'opacity', duration: 180 },
  update: { type: 'spring', springDamping: 0.86 },
  delete: { type: 'easeInEaseOut', property: 'opacity', duration: 140 },
};
export function animateLayout(kind = 'spring') {
  if (isReduceMotionEnabled()) return false;
  try { if (globalThis.__chatyy_motion_all === false) return false; } catch {}
  let k = kind;
  try { if (globalThis.__chatyy_motion_layout === false) k = 'ease'; } catch {}
  try {
    LayoutAnimation.configureNext(k === 'ease' ? LayoutAnimation.Presets.easeInEaseOut : _LAYOUT_SPRING);
    return true;
  } catch { return false; }
}

// Elástico iOS p/ arrastar além do limite (offset ≥ 0).
export function rubberBand(offset, limit = 300, coeff = Gestures.sheetRubberBand) {
  if (offset <= 0) return 0;
  return (1 - 1 / ((offset * coeff) / limit + 1)) * limit;
}

// Hook p/ componentes: re-renderiza quando Reduzir Movimento muda.
export function useMotion() {
  const reduce = useReducedMotion();
  return {
    reduce,
    enabled: (feature) => !reduce && motionEnabled(feature),
    Springs, Durations, PressScale, Distances, Gestures,
  };
}

// ── Haptics unificado ──────────────────────────────────────────────────────
// Todas passam por services/haptics (iOS Core Haptics / Android
// performHapticFeedback) e respeitam "Vibração ao tocar". Web = no-op.
const _web = Platform.OS === 'web';
// Lazy: services/haptics carrega o módulo nativo (iOS Core Haptics) — só no 1º toque.
let _H = null;
function _hx() { if (!_H) { try { _H = require('../services/haptics'); } catch { _H = {}; } } return _H; }
function _h(fn) { return () => { if (_web) return; try { fn(_hx()); } catch {} }; }
export const feedback = {
  light: _h((H) => H.tap('light')),       // toque em ação, mostrar toast, reação
  medium: _h((H) => H.tap('medium')),     // long-press / menu de contexto
  heavy: _h((H) => H.tap('heavy')),
  soft: _h((H) => H.tap('soft')),         // soltar/fechar folha, pull-to-refresh armado
  rigid: _h((H) => H.tap('rigid')),       // encaixe (snap), obturador
  selection: _h((H) => H.selection()),    // aba/segmento/toggle/checkbox/picker
  success: _h((H) => H.success()),        // resultado OK
  warning: _h((H) => H.warning()),
  error: _h((H) => H.error()),
  event: (name) => { if (_web) return; try { _hx().hapticEvent(name); } catch {} }, // tabela canônica (services/haptics)
};

export default {
  Springs, Durations, Easings, PressScale, Distances, Gestures,
  springTo, timingTo, motionEnabled, rubberBand, animateLayout, useMotion, feedback,
};
