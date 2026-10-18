// components/chatlist/ChipRail.js — WEB/fallback.
// [2026-10-16 motion-nav] O trilho nativo (ChipRail.native.js) usa Reanimated.
// [2026-10-18 tg-list] Web ganhou a MESMA pílula deslizante (Telegram): uma
// pílula única desliza com mola (Animated, driver JS — a web não tem driver
// nativo) até o chip tocado e cada chip inverte as cores na proporção em que
// a pílula o cobre. Mesma API do .native.js:
//
//   <ChipRail activeKey={filter} pillColor={P.pillBg} onActiveLayout={fn}>
//     <RailChip value="all" active={…} renderContent={(on) => …} … />
//   </ChipRail>
//
// onActiveLayout({x, width}) é chamado quando o chip ativo muda (o
// ChatListTab rola a fileira p/ centralizá-lo). Kill switch:
// globalThis.__chatyy_motion_chips = false → chips antigos (FilterChip).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, TouchableOpacity } from 'react-native';
import { isReduceMotionEnabled } from '../reducedMotion';

const PILL_SPRING = { damping: 30, stiffness: 340, mass: 1, useNativeDriver: false };

export function chipRailEnabled() {
  try { if (globalThis.__chatyy_motion_chips === false) return false; } catch {}
  return true;
}

const RailCtx = createContext(null);

export function ChipRail({ activeKey, pillColor, onActiveLayout, children }) {
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const h = useRef(new Animated.Value(0)).current;
  const ready = useRef(new Animated.Value(0)).current;
  const layouts = useRef(new Map());
  const activeRef = useRef(activeKey);
  const placedRef = useRef(false);
  const notifiedRef = useRef(null);
  const cbRef = useRef(onActiveLayout);
  cbRef.current = onActiveLayout;

  const moveTo = useCallback((key) => {
    const l = layouts.current.get(key);
    if (!l) return;
    let reduced = false;
    try { reduced = !!isReduceMotionEnabled(); } catch {}
    const animate = placedRef.current && !reduced;
    y.setValue(l.y);
    h.setValue(l.height);
    x.stopAnimation(); w.stopAnimation();
    if (animate) {
      Animated.parallel([
        Animated.spring(x, { toValue: l.x, ...PILL_SPRING }),
        Animated.spring(w, { toValue: l.width, ...PILL_SPRING }),
      ]).start();
    } else {
      x.setValue(l.x);
      w.setValue(l.width);
    }
    placedRef.current = true;
    ready.setValue(1);
    if (notifiedRef.current !== key) {
      notifiedRef.current = key;
      try { cbRef.current?.({ x: l.x, width: l.width }); } catch {}
    }
  }, [x, y, w, h, ready]);

  const onChipLayout = useCallback((key, l) => {
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
    else ready.setValue(0);
  }, [activeKey, moveTo, ready]);

  const ctx = useMemo(() => ({ x, ready, onChipLayout, onChipGone }), [x, ready, onChipLayout, onChipGone]);

  return (
    <RailCtx.Provider value={ctx}>
      <Animated.View
        pointerEvents="none"
        style={[st.pill, { backgroundColor: pillColor, opacity: ready, top: y, height: h, width: w, transform: [{ translateX: x }] }]}
      />
      {children}
    </RailCtx.Provider>
  );
}

/** Um chip do trilho — mesma API do ChipRail.native.js. */
export function RailChip({ value, active, style, baseBg, activeBg, renderContent, onPress, onLongPress, delayLongPress, accessibilityLabel, testID }) {
  const ctx = useContext(RailCtx);
  const [lay, setLay] = useState(null);
  const onLayout = useCallback((e) => {
    const l = e?.nativeEvent?.layout;
    if (!l) return;
    setLay(prev => (prev && prev.x === l.x && prev.width === l.width ? prev : { x: l.x, width: l.width }));
    try { ctx?.onChipLayout(value, l); } catch {}
  }, [ctx, value]);
  useEffect(() => () => { try { ctx?.onChipGone(value); } catch {} }, [ctx, value]);

  // Cobertura da pílula sobre este chip: 1 com a pílula em cima, 0 a uma
  // largura de distância (a pílula assume a largura do chip de destino).
  const cov = useMemo(() => {
    if (!ctx || !lay || !(lay.width > 0)) return null;
    return ctx.x.interpolate({
      inputRange: [lay.x - lay.width, lay.x, lay.x + lay.width],
      outputRange: [0, 1, 0],
      extrapolate: 'clamp',
    });
  }, [ctx, lay]);
  const off = useMemo(() => (cov ? Animated.subtract(1, cov) : (active ? 0 : 1)), [cov, active]);
  const on = cov || (active ? 1 : 0);

  return (
    <TouchableOpacity
      style={[style, st.clear, Platform.OS === 'web' ? st.web : null]}
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
      <Animated.View pointerEvents="none" style={[st.fill, { backgroundColor: baseBg, opacity: off }]} />
      {!cov && active ? <Animated.View pointerEvents="none" style={[st.fill, { backgroundColor: activeBg }]} /> : null}
      <Animated.View style={[st.row, { opacity: off }]}>{renderContent(false)}</Animated.View>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={[st.fill, st.row, st.center, { opacity: on }]}
      >
        {renderContent(true)}
      </Animated.View>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  pill: { position: 'absolute', left: 0, borderRadius: 999 },
  clear: { backgroundColor: 'transparent' },
  web: { cursor: 'pointer' },
  fill: { ...StyleSheet.absoluteFillObject, borderRadius: 999 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  center: { justifyContent: 'center' },
});
