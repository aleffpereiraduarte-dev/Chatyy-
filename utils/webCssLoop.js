// [2026-10-15 web-idle] Loop de animação em CSS puro p/ o WEB.
//
// No react-native-web não existe driver nativo: um `Animated.loop` roda em
// requestAnimationFrame e força um commit do React a CADA quadro (60/s em
// repouso em /chat, /u, /plans, /live-discover, /notes — auditoria 15/10).
// Com @keyframes o navegador anima no compositor e o React fica parado.
//
// Uso:
//   const css = cssLoop({ '0%': { transform: [{ scale: 1 }] }, '100%': { transform: [{ scale: 1.05 }] } },
//                       { duration: 1300, direction: 'alternate' });
//   if (css) → <View style={[base, css]}/> e NÃO inicia o Animated.loop.
// Em iOS/Android devolve null (mantém o Animated com useNativeDriver).
//
// Os estilos são compilados por StyleSheet.create (único caminho do RN-web que
// aceita `animationKeyframes`) e memoizados por parâmetros.
import { Platform, StyleSheet } from 'react-native';

export const IS_WEB = Platform.OS === 'web';
const _cache = new Map();

export function cssLoop(frames, opts = {}) {
  if (!IS_WEB || !frames) return null;
  const {
    duration = 1000,
    iterations = 'infinite',
    easing = 'ease-in-out',
    direction = 'normal',
    delay = 0,
    fill = null,
  } = opts;
  let key;
  try { key = JSON.stringify([frames, duration, iterations, easing, direction, delay, fill]); } catch { return null; }
  let s = _cache.get(key);
  if (!s) {
    try {
      const st = {
        animationKeyframes: [frames],
        animationDuration: Math.max(1, Math.round(duration)) + 'ms',
        animationIterationCount: iterations,
        animationTimingFunction: easing,
        animationDirection: direction,
      };
      if (delay) st.animationDelay = Math.round(delay) + 'ms';
      if (fill) st.animationFillMode = fill;
      s = StyleSheet.create({ a: st }).a;
    } catch { s = null; }
    if (_cache.size > 200) _cache.clear();
    _cache.set(key, s);
  }
  return s;
}

// Atalhos comuns.
export function cssPulseScale(to, duration, opts = {}) {
  return cssLoop({ '0%': { transform: [{ scale: opts.from ?? 1 }] }, '100%': { transform: [{ scale: to }] } },
    { duration, direction: 'alternate', ...opts, iterations: opts.iterations ?? 'infinite' });
}

export default cssLoop;
