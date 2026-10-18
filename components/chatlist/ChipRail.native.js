// components/chatlist/ChipRail.native.js — [2026-10-16 motion-nav]
// Chips de filtro da lista de conversas com INDICADOR DESLIZANTE (Telegram):
// uma pílula única desliza com mola até o chip tocado (x + largura na UI
// thread) e cada chip inverte as cores na proporção em que a pílula o cobre —
// o texto "vira" branco/preto exatamente quando a pílula passa por baixo, sem
// troca seca de fundo nem frame com texto claro em fundo claro.
//
//   <ScrollView horizontal …>
//     <ChipRail activeKey={filter} pillColor={P.pillBg}>
//       <RailChip value="all" active={filter === 'all'} … renderContent={(on) => …} />
//       …
//     </ChipRail>
//   </ScrollView>
//
// ChipRail não cria view (Provider + pílula absoluta como 1º filho do content
// container) → o layout da fileira é o mesmo de antes.
// OTA SAFETY: só com Reanimated já carregado por utils/threadKeyboard (mesma
// guarda do SwipeReplyRow/AttachSheet). Sem ele (ou kill switch
// globalThis.__chatyy_motion_chips = false) chipRailEnabled() = false e o
// ChatListTab usa os chips antigos.
// Reduzir Movimento → a pílula salta direto (sem mola).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import { isReduceMotionEnabled } from '../reducedMotion';

let Rea = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
  } catch {
    Rea = null;
  }
}

const REA_OK = !!(
  Rea && Rea.default && Rea.default.View && Rea.useSharedValue && Rea.useAnimatedStyle
  && Rea.useDerivedValue && Rea.withSpring && Rea.cancelAnimation
);
const AView = REA_OK ? Rea.default.View : View;
const withSpring = REA_OK ? Rea.withSpring : null;
const cancelAnimation = REA_OK ? Rea.cancelAnimation : null;
const useSharedValue = REA_OK ? Rea.useSharedValue : null;
const useAnimatedStyle = REA_OK ? Rea.useAnimatedStyle : null;
const useDerivedValue = REA_OK ? Rea.useDerivedValue : null;

// Mola da pílula: ζ ≈ 0,81 (assenta com um fio de overshoot), ~0,32 s.
// Token local — constants/motion* é do agente de micro-interações.
const PILL_SPRING = { damping: 30, stiffness: 340, mass: 1 };

export function chipRailEnabled() {
  if (!REA_OK) return false;
  try { if (globalThis.__chatyy_motion_chips === false) return false; } catch {}
  return true;
}

const RailCtx = createContext(null);

export function ChipRail({ activeKey, pillColor, onActiveLayout, children }) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const ready = useSharedValue(0);
  const layouts = useRef(new Map());
  const activeRef = useRef(activeKey);
  const placedRef = useRef(false);
  // [2026-10-18 tg-list] avisa o ChatListTab quando o chip ativo muda (centraliza a fileira).
  const notifiedRef = useRef(null);
  const cbRef = useRef(onActiveLayout);
  cbRef.current = onActiveLayout;

  const moveTo = useCallback((key) => {
    const l = layouts.current.get(key);
    if (!l) return;
    const animate = placedRef.current && !isReduceMotionEnabled();
    y.value = l.y;
    h.value = l.height;
    if (animate) {
      x.value = withSpring(l.x, PILL_SPRING);
      w.value = withSpring(l.width, PILL_SPRING);
    } else {
      cancelAnimation(x); cancelAnimation(w);
      x.value = l.x;
      w.value = l.width;
    }
    placedRef.current = true;
    ready.value = 1;
    if (notifiedRef.current !== key) {
      notifiedRef.current = key;
      try { cbRef.current?.({ x: l.x, width: l.width }); } catch {}
    }
  }, [x, y, w, h, ready]);

  const onChipLayout = useCallback((key, e) => {
    const l = e?.nativeEvent?.layout;
    if (!l || !(l.width > 0)) return;
    const prev = layouts.current.get(key);
    if (prev && prev.x === l.x && prev.y === l.y && prev.width === l.width && prev.height === l.height) return;
    layouts.current.set(key, { x: l.x, y: l.y, width: l.width, height: l.height });
    if (key === activeRef.current) moveTo(key);
  }, [moveTo]);

  const onChipGone = useCallback((key) => { layouts.current.delete(key); }, []);

  useEffect(() => {
    activeRef.current = activeKey;
    if (layouts.current.has(activeKey)) moveTo(activeKey);
    else ready.value = 0; // chip ativo sem layout (ex.: pasta recém-criada) → cada chip pinta o próprio estado
  }, [activeKey, moveTo, ready]);

  const ctx = useMemo(() => ({ x, w, ready, onChipLayout, onChipGone }), [x, w, ready, onChipLayout, onChipGone]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: ready.value,
    top: y.value,
    height: h.value,
    width: w.value,
    transform: [{ translateX: x.value }],
  }));

  return (
    <RailCtx.Provider value={ctx}>
      <AView pointerEvents="none" style={[st.pill, { backgroundColor: pillColor }, pillStyle]} />
      {children}
    </RailCtx.Provider>
  );
}

/**
 * Um chip do trilho. `renderContent(on)` desenha o conteúdo (texto/contador/
 * ícone) nas cores de inativo (on=false) ou de ativo (on=true); as duas
 * camadas se cruzam pela cobertura da pílula. `baseBg` = fundo do chip inativo,
 * `activeBg` = fundo do ativo (só antes da pílula ter posição).
 */
export function RailChip({ value, active, style, baseBg, activeBg, renderContent, onPress, onLongPress, delayLongPress, accessibilityLabel, testID }) {
  const ctx = useContext(RailCtx);
  const cx = useSharedValue(-1);
  const cw = useSharedValue(0);
  const act = useSharedValue(active ? 1 : 0);
  useEffect(() => { act.value = active ? 1 : 0; }, [active, act]);

  const rx = ctx ? ctx.x : null;
  const rw = ctx ? ctx.w : null;
  const rready = ctx ? ctx.ready : null;
  const cov = useDerivedValue(() => {
    if (!rready || rready.value < 1 || cw.value <= 0) return act.value;
    const l = Math.max(cx.value, rx.value);
    const r = Math.min(cx.value + cw.value, rx.value + rw.value);
    const c = (r - l) / cw.value;
    return c <= 0 ? 0 : c >= 1 ? 1 : c;
  });
  const baseBgStyle = useAnimatedStyle(() => ({ opacity: 1 - cov.value }));
  const ownActiveStyle = useAnimatedStyle(() => ({ opacity: (rready && rready.value >= 1) ? 0 : act.value }));
  const offStyle = useAnimatedStyle(() => ({ opacity: 1 - cov.value }));
  const onStyle = useAnimatedStyle(() => ({ opacity: cov.value }));

  const onLayout = useCallback((e) => {
    const l = e?.nativeEvent?.layout;
    if (l) { cx.value = l.x; cw.value = l.width; }
    try { ctx?.onChipLayout(value, e); } catch {}
  }, [ctx, value, cx, cw]);
  useEffect(() => () => { try { ctx?.onChipGone(value); } catch {} }, [ctx, value]);

  return (
    <TouchableOpacity
      style={[style, st.clear]}
      onLayout={onLayout}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <AView pointerEvents="none" style={[st.fill, { backgroundColor: baseBg }, baseBgStyle]} />
      <AView pointerEvents="none" style={[st.fill, { backgroundColor: activeBg }, ownActiveStyle]} />
      <AView style={[st.row, offStyle]}>{renderContent(false)}</AView>
      <AView
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[st.fill, st.row, st.center, onStyle]}
      >
        {renderContent(true)}
      </AView>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  pill: { position: 'absolute', left: 0, borderRadius: 999 },
  clear: { backgroundColor: 'transparent' },
  fill: { ...StyleSheet.absoluteFillObject, borderRadius: 999 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  center: { justifyContent: 'center' },
});
