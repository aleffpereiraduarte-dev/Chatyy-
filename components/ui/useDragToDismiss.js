// useDragToDismiss — "arrastar de QUALQUER ponto p/ baixo fecha" (2026-10-17).
//
// Regra geral do app (founder): toda folha/modal desce arrastando de onde for.
// Extraído do AppsSheet (RNGH Pan simultâneo com o ScrollView via
// Gesture.Native) p/ as folhas que mantêm o próprio <Modal>:
//
//   const drag = useDragToDismiss({ visible, onDismiss: onClose });
//   <Modal transparent visible={visible} onRequestClose={onClose}>
//     <DragSheetRoot>                                   // GH root (Modal = outra janela no Android)
//       <Animated.View style={[backdrop, drag.backdropStyle]}>…</Animated.View>
//       <DragPanel drag={drag} style={panelStyle}>      // painel inteiro arrasta
//         <DragScroll drag={drag}><ScrollView …/></DragScroll>   // rola; no topo, a folha assume
//       </DragPanel>
//     </DragSheetRoot>
//   </Modal>
//
// Comportamento (= Sheet.js / AppsSheet): só um arrasto VERTICAL p/ baixo claro
// é capturado (toques/horizontal seguem p/ o conteúdo); dentro de um <DragScroll>
// só quando ele está no topo — se estava rolado, a lista sobe até o topo e a
// folha assume no MESMO gesto; fundo esmaece proporcional; soltar segue a
// velocidade do dedo (mola), volta com mola se não passar do limiar
// (Gestures.sheetDismissDistance / sheetDismissVelocity); recolhe o teclado.
// Rascunho não salvo: `shouldConfirm()` → true = a folha volta e chama
// `onDismissAttempt()` (ex.: Alert "Descartar alterações?") em vez de fechar.
// Kill switch: globalThis.__chatyy_motion_sheet_drag = false → sem arrasto
// (comportamento anterior). Reduzir Movimento: arrasta, mas fecha sem mola.
// Web/sem RNGH: PanResponder no painel (fora dos <DragScroll>, ou no topo deles).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, PanResponder, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Springs, Gestures } from '../../constants/motion';
import { isReduceMotionEnabled } from '../reducedMotion';

let _GH = null;
if (Platform.OS !== 'web') {
  try { _GH = require('react-native-gesture-handler'); } catch { _GH = null; } // eslint-disable-line global-require
}
const GH_OK = !!(_GH && _GH.Gesture && _GH.Gesture.Pan && _GH.Gesture.Native && _GH.GestureDetector && _GH.GestureHandlerRootView);
const USE_NATIVE = Platform.OS !== 'web';

export function dragToDismissEnabled() {
  try { if (globalThis.__chatyy_motion_sheet_drag === false) return false; } catch {}
  return true;
}

export default function useDragToDismiss({
  visible,
  onDismiss,
  enabled = true,
  shouldConfirm,
  onDismissAttempt,
  // px do topo do painel onde o arrasto pode começar (fora de <DragScroll>).
  // Use quando o corpo tem lista própria que não dá p/ envolver (ex.: GifPicker).
  startZone = 0,
  distance = Gestures.sheetDismissDistance,
  velocity = Gestures.sheetDismissVelocity,
} = {}) {
  const { height: winH } = useWindowDimensions();
  const dragY = useRef(new Animated.Value(0)).current;
  const [panelH, setPanelH] = useState(0);
  const panelHRef = useRef(0);
  const cbRef = useRef({});
  cbRef.current = { onDismiss, shouldConfirm, onDismissAttempt, distance, velocity, startZone };
  // `visible` opcional: sem ele, o fechamento é detectado pela desmontagem do
  // <DragPanel> (RN <Modal visible={false}> desmonta os filhos).
  const hasVisible = visible !== undefined;
  const visibleRef = useRef(hasVisible ? !!visible : true);
  visibleRef.current = hasVisible ? !!visible : true;
  const hasVisibleRef = useRef(hasVisible);
  hasVisibleRef.current = hasVisible;
  const on = enabled && dragToDismissEnabled();
  const onRef = useRef(on);
  onRef.current = on;
  // Painel montado? (RN <Modal visible={false}> desmonta os filhos → fechou de verdade.)
  const panelMountedRef = useRef(false);
  const onPanelMount = useCallback((m) => {
    panelMountedRef.current = m;
    if (!m) dragY.setValue(0); // próxima abertura nasce no lugar
  }, [dragY]);
  // Scroller sob o dedo (DragScroll registra no onBegin/onTouchStart).
  const scrollRef = useRef(null); // { y: number } | null

  useEffect(() => { if (visible) dragY.setValue(0); }, [visible, dragY]);

  const springBack = useCallback((vy = 0) => {
    Animated.spring(dragY, { toValue: 0, ...Springs.sheet, velocity: vy * 1000, useNativeDriver: USE_NATIVE }).start();
  }, [dragY]);

  const settle = useCallback((dy, vy) => {
    const c = cbRef.current;
    if (!(dy > c.distance || vy > c.velocity)) { springBack(vy); return; }
    let block = false;
    try { block = !!(c.shouldConfirm && c.shouldConfirm()); } catch {}
    if (block) {
      springBack(0);
      try { c.onDismissAttempt && c.onDismissAttempt(); } catch {}
      return;
    }
    const to = (panelHRef.current || winH) + 40;
    const done = () => {
      try { cbRef.current.onDismiss && cbRef.current.onDismiss(); } catch {}
      // Pai ignorou o fechamento → o painel volta. Sem `visible`: zera depois
      // da animação de saída do <Modal> (~300 ms).
      setTimeout(() => {
        if (hasVisibleRef.current ? visibleRef.current : panelMountedRef.current) springBack(0);
      }, 450);
    };
    if (isReduceMotionEnabled()) {
      Animated.timing(dragY, { toValue: to, duration: 120, useNativeDriver: USE_NATIVE }).start(done);
    } else {
      Animated.spring(dragY, {
        toValue: to, velocity: Math.max(0, vy) * 1000, ...Springs.sheet,
        overshootClamping: true, restDisplacementThreshold: 2, restSpeedThreshold: 40, useNativeDriver: USE_NATIVE,
      }).start(done);
    }
  }, [dragY, springBack, winH]);

  const canStart = () => {
    const s = scrollRef.current;
    if (s) return s.y <= 0.5;
    const z = cbRef.current.startZone;
    return !(z > 0 && st.current.y0 > z);
  };

  // RNGH (iOS/Android).
  const st = useRef({ active: false, base: 0, prev: 0, y0: 0 });
  const scrollClaimedRef = useRef(false);
  const primaryPosRef = useRef(null); // posição do 1º <DragScroll> (gesto nativo pré-criado)
  const gestures = useMemo(() => {
    if (!GH_OK) return null;
    try {
      const native = _GH.Gesture.Native().runOnJS(true)
        .onBegin(() => { scrollRef.current = primaryPosRef.current || { y: 0 }; });
      const panG = _GH.Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-8, 8])
        .failOffsetX([-14, 14])
        .onBegin((e) => { const g = st.current; g.active = false; g.base = 0; g.prev = 0; g.y0 = (e && e.y) || 0; })
        .onUpdate((e) => {
          if (!onRef.current) return;
          const g = st.current;
          const ty = (e && e.translationY) || 0;
          if (!g.active && ty > g.prev && canStart()) {
            g.active = true;
            g.base = g.prev;
            dragY.stopAnimation();
            try { Keyboard.dismiss(); } catch {}
          }
          if (g.active) dragY.setValue(Math.max(0, ty - g.base));
          g.prev = ty;
        })
        .onEnd((e) => {
          const g = st.current;
          if (!g.active) return;
          g.active = false;
          settle(Math.max(0, ((e && e.translationY) || 0) - g.base), ((e && e.velocityY) || 0) / 1000);
        })
        .onFinalize(() => {
          const g = st.current;
          if (g.active) { g.active = false; springBack(0); }
          scrollRef.current = null;
        })
        .simultaneousWithExternalGesture(native);
      return { pan: panG, native };
    } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback (web / sem RNGH).
  const pan = useMemo(() => (GH_OK ? null : PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => onRef.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2 && canStart(),
    onPanResponderGrant: () => { dragY.stopAnimation(); try { Keyboard.dismiss(); } catch {} },
    onPanResponderMove: (_e, g) => { dragY.setValue(Math.max(0, g.dy)); },
    onPanResponderRelease: (_e, g) => { scrollRef.current = null; settle(Math.max(0, g.dy), g.vy); },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => { scrollRef.current = null; springBack(0); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), []);

  const onPanelLayout = useCallback((e) => {
    const h = e && e.nativeEvent && e.nativeEvent.layout && e.nativeEvent.layout.height;
    if (h > 0) { panelHRef.current = h; setPanelH((p) => (Math.abs(p - h) > 1 ? h : p)); }
  }, []);

  const backdropOpacity = useMemo(() => dragY.interpolate({
    inputRange: [0, Math.max(200, panelH || Math.round(winH * 0.5))], outputRange: [1, 0], extrapolate: 'clamp',
  }), [dragY, panelH, winH]);

  return useMemo(() => ({
    enabled: on,
    translateY: dragY,
    backdropOpacity,
    backdropStyle: { opacity: backdropOpacity },
    onPanelLayout,
    onPanelMount,
    gesture: on && gestures ? gestures.pan : null,
    scrollGesture: on && gestures ? gestures.native : null,
    panHandlers: on && pan ? pan.panHandlers : null,
    scrollRef,
    primaryPosRef,
    _scrollClaimed: scrollClaimedRef,
    reset: () => dragY.setValue(0),
  }), [on, dragY, backdropOpacity, onPanelLayout, onPanelMount, gestures, pan]);
}

// Raiz do gesto dentro do <Modal> RN (outra janela/raiz: RNGH precisa da própria).
export function DragSheetRoot({ style, children, ...rest }) {
  if (GH_OK) {
    const R = _GH.GestureHandlerRootView;
    return <R style={[styles.fill, style]} {...rest}>{children}</R>;
  }
  return <View style={[styles.fill, style]} {...rest}>{children}</View>;
}

function _withTranslate(style, ty) {
  const flat = StyleSheet.flatten(style) || {};
  const t = Array.isArray(flat.transform) ? flat.transform : [];
  return [style, { transform: [...t, { translateY: ty }] }];
}

// Painel arrastável (Animated.View). Mantém o estilo/transform do chamador e
// soma o arrasto. `onLayout` do chamador continua sendo chamado.
export function DragPanel({ drag, style, children, onLayout, ...rest }) {
  const mountCb = drag && drag.onPanelMount;
  useEffect(() => {
    if (!mountCb) return undefined;
    mountCb(true);
    return () => mountCb(false);
  }, [mountCb]);
  const handleLayout = useCallback((e) => {
    try { drag && drag.onPanelLayout && drag.onPanelLayout(e); } catch {}
    if (onLayout) onLayout(e);
  }, [drag, onLayout]);
  if (!drag || !drag.enabled) {
    return <Animated.View style={style} onLayout={onLayout} {...rest}>{children}</Animated.View>;
  }
  const el = (
    <Animated.View
      style={_withTranslate(style, drag.translateY)}
      onLayout={handleLayout}
      {...(drag.panHandlers || null)}
      {...rest}
    >
      {children}
    </Animated.View>
  );
  return drag.gesture ? <_GH.GestureDetector gesture={drag.gesture}>{el}</_GH.GestureDetector> : el;
}

// Envolve UM ScrollView/FlatList/SectionList dentro do DragPanel: a lista rola
// normalmente; no topo, puxar p/ baixo passa a descer a folha.
export function DragScroll({ drag, children, disabled = false }) {
  const posRef = useRef({ y: 0 });
  const child = React.Children.only(children);
  // 1º scroller usa o gesto nativo pré-criado (pan já simultâneo com ele);
  // demais (raro: abas) criam o próprio e registram a simultaneidade.
  const claimRef = useRef(null);
  const native = useMemo(() => {
    if (!GH_OK || !drag || !drag.gesture || disabled) return null;
    try {
      if (drag.scrollGesture && !drag._scrollClaimed.current) {
        drag._scrollClaimed.current = true;
        claimRef.current = 'primary';
        drag.primaryPosRef.current = posRef.current;
        return drag.scrollGesture;
      }
      const g = _GH.Gesture.Native().runOnJS(true).onBegin(() => { drag.scrollRef.current = posRef.current; });
      try { drag.gesture.simultaneousWithExternalGesture(g); } catch {}
      return g;
    } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag && drag.gesture, disabled]);
  useEffect(() => () => {
    if (claimRef.current === 'primary' && drag) { drag._scrollClaimed.current = false; drag.primaryPosRef.current = null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!drag || !drag.enabled || disabled) return child;
  const p = child.props || {};
  const userOnScroll = typeof p.onScroll === 'function' ? p.onScroll : null;
  const extra = {
    scrollEventThrottle: p.scrollEventThrottle || 16,
    // iOS: no topo o "quique" brigaria com a folha descendo (dois movimentos).
    ...(Platform.OS === 'ios' && p.bounces === undefined ? { bounces: false } : null),
  };
  if (!p.onScroll || userOnScroll) {
    extra.onScroll = (e) => {
      try { posRef.current.y = (e && e.nativeEvent && e.nativeEvent.contentOffset && e.nativeEvent.contentOffset.y) || 0; } catch {}
      if (userOnScroll) userOnScroll(e);
    };
  }
  if (!native) {
    const userTouch = p.onTouchStart;
    extra.onTouchStart = (e) => { drag.scrollRef.current = posRef.current; if (typeof userTouch === 'function') userTouch(e); };
  }
  const cloned = React.cloneElement(child, extra);
  return native ? <_GH.GestureDetector gesture={native}>{cloned}</_GH.GestureDetector> : cloned;
}

// Fundo (escurecido) que esmaece proporcional ao arrasto. Toque fecha se `onPress`.
// Use como 1º filho do container (absoluto) no lugar do backgroundColor do scrim.
// `inline`: ocupa o espaço ACIMA do painel (flex:1, irmão anterior) em vez de absoluto.
export function DragBackdrop({ drag, color = 'rgba(0,0,0,0.5)', onPress, style, accessibilityLabel, inline = false }) {
  return (
    <Animated.View pointerEvents={onPress ? 'auto' : 'none'} style={[inline ? styles.fill : StyleSheet.absoluteFill, { backgroundColor: color }, drag && drag.enabled ? drag.backdropStyle : null, style]}>
      {onPress ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel || 'Fechar'} />
      ) : null}
    </Animated.View>
  );
}

// Envolve um fundo JÁ existente (ex.: <Pressable style={styles.backdrop} …/>) p/
// esmaecer com o arrasto sem mudar o layout: absoluto → invólucro absoluto;
// senão → invólucro flex (ocupa o espaço acima do painel, como antes).
export function DragFade({ drag, children }) {
  if (!drag || !drag.enabled) return children;
  let flat = {};
  try { flat = StyleSheet.flatten(React.Children.only(children).props.style) || {}; } catch {}
  const wrap = flat.position === 'absolute' ? StyleSheet.absoluteFill : { flex: flat.flex != null ? flat.flex : 1 };
  return <Animated.View style={[wrap, drag.backdropStyle]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
