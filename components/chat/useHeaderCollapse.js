// [2026-10-20 tg-header] Cabeçalho da conversa encolhe ao rolar (Telegram/Safari):
//   - rolar em direção às mensagens novas (dedo p/ cima) → modo compacto: barra 8 pt
//     mais baixa, foto 38→30, nome/presença 92 %, fundo vira material com blur;
//   - rolar para cima (histórico, dedo p/ baixo) ou chegar na última mensagem → normal.
// Entrada = distância da mensagem mais nova que a lista JÁ entrega no onScroll
// (nativo: onScrollState sintético do nativeThreadList; JS: FlatList/FlashList).
// O JS só decide o estado (histerese, sem setState); a transição é withTiming num
// shared value → anima na UI thread, ZERO re-render da tela.
// Kill: globalThis.__chatyy_header_collapse = false.
import { useCallback, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

let RA = null;
try { RA = require('react-native-reanimated'); } catch {}
const _ok = !!(RA && RA.useSharedValue && RA.useAnimatedStyle && RA.withTiming && RA.interpolateColor && RA.default && RA.default.View);

// Worklets não podem capturar o módulo inteiro (RA.*) → função solta.
const _interpolateColor = _ok ? RA.interpolateColor : null;

export function headerCollapseOn() {
  return _ok && globalThis.__chatyy_header_collapse !== false;
}

// Limiares (pt). Pequenos o bastante p/ responder rápido, grandes o bastante p/
// não piscar com o ajuste de layout (mídia medindo, teclado).
const COMPACT_AFTER = 36;   // acumulado rumo às novas
const EXPAND_AFTER = 24;    // acumulado rumo ao histórico
const MIN_DIST = 120;       // só compacta longe do fim
const AT_LATEST = 8;        // na última mensagem = normal
export const HEADER_SHRINK = 8; // pt que a barra perde (padding 6/6 → 2/2)

const _noop = () => {};
const _staticHook = { onDist: _noop, isCompact: () => false, hdrStyle: null, avatarStyle: null, titleStyle: null, blurStyle: null, AnimatedView: null, on: false };

function _reduced() { try { return !!require('../reducedMotion').isReduceMotionEnabled(); } catch { return false; } }

function useHeaderCollapseImpl(topInset, bgColor) {
  const p = RA.useSharedValue(0);
  const st = useRef({ last: -1, acc: 0, compact: false }).current;

  const setCompact = useCallback((c) => {
    if (st.compact === c) return;
    st.compact = c;
    st.acc = 0;
    p.value = RA.withTiming(c ? 1 : 0, { duration: _reduced() ? 0 : 180 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Chamado do onScroll (JS, ~15/s no nativo). Só aritmética — barato.
  const onDist = useCallback((dist) => {
    if (globalThis.__chatyy_header_collapse === false) { if (st.compact) setCompact(false); return; }
    const d = Number(dist);
    if (!(d >= 0)) return;
    const prev = st.last;
    st.last = d;
    if (prev < 0) return;
    if (d <= AT_LATEST) { setCompact(false); return; }
    const delta = prev - d; // > 0 = rumo às novas
    if (Math.abs(delta) > 2000) { st.acc = 0; return; } // salto (ir p/ citada, fim) não conta
    if ((delta > 0) !== (st.acc > 0)) st.acc = 0; // mudou de direção → recomeça
    st.acc += delta;
    if (!st.compact && st.acc >= COMPACT_AFTER && d > MIN_DIST) setCompact(true);
    else if (st.compact && st.acc <= -EXPAND_AFTER) setCompact(false);
  }, [setCompact]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCompact = useCallback(() => st.compact, []); // eslint-disable-line react-hooks/exhaustive-deps

  const top = Number(topInset) || 0;
  const bg = String(bgColor || '#ffffff');
  const bg0 = /^#[0-9a-f]{6}$/i.test(bg)
    ? `rgba(${parseInt(bg.slice(1, 3), 16)},${parseInt(bg.slice(3, 5), 16)},${parseInt(bg.slice(5, 7), 16)},0)`
    : 'rgba(0,0,0,0)';
  // Fundo sólido some no compacto → o material com blur (HeaderCollapseBackdrop) aparece.
  const hdrStyle = RA.useAnimatedStyle(() => {
    const s = (HEADER_SHRINK / 2) * p.value;
    return {
      paddingTop: top + 6 - s, paddingBottom: 6 - s, minHeight: 56 - HEADER_SHRINK * p.value,
      backgroundColor: _interpolateColor(p.value, [0, 1], [bg, bg0]),
    };
  }, [top, bg, bg0]);
  const avatarStyle = RA.useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.21 * p.value }] }));
  // Escala a partir da borda esquerda (o nome não "foge" do avatar).
  const titleStyle = RA.useAnimatedStyle(() => ({ transformOrigin: 'left center', transform: [{ scale: 1 - 0.08 * p.value }] }));
  const blurStyle = RA.useAnimatedStyle(() => ({ opacity: p.value }));

  return { onDist, isCompact, hdrStyle, avatarStyle, titleStyle, blurStyle, AnimatedView: RA.default.View, on: true };
}

// Hook estável: decide no 1º render (kill switch lido uma vez por montagem da tela).
export function useHeaderCollapse(topInset, bgColor) {
  const onRef = useRef(null);
  if (onRef.current === null) onRef.current = headerCollapseOn();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return onRef.current ? useHeaderCollapseImpl(topInset, bgColor) : _staticHook;
}

// Fundo "material" do modo compacto: BlurView (iOS/Android) ou backdrop-filter (web),
// esmaecendo com o progresso. Fica atrás do conteúdo, sem toque.
let _Blur = null;
function _blurComp() {
  if (_Blur !== null) return _Blur;
  _Blur = false;
  if (Platform.OS === 'web') return _Blur;
  try { _Blur = require('expo-blur').BlurView || false; } catch {}
  return _Blur;
}

export function HeaderCollapseBackdrop({ hc, isDark }) {
  if (!hc || !hc.on || !hc.AnimatedView) return null;
  const AV = hc.AnimatedView;
  const B = _blurComp();
  const tint = isDark ? 'rgba(11,11,11,0.72)' : 'rgba(255,255,255,0.72)';
  return (
    <AV pointerEvents="none" style={[StyleSheet.absoluteFill, hc.blurStyle]}>
      {B ? (
        <B intensity={40} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      ) : null}
      <AV pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }, Platform.OS === 'web' ? { backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)' } : null]} />
    </AV>
  );
}
