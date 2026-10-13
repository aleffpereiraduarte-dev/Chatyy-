// [2026-10-13 video-studio] Alça arrastável horizontal (handles de corte, barras
// de texto na timeline, reordenar clips). Com Reanimated o deslocamento roda na
// UI thread e o JS só recebe o valor final (onEnd(dx)); sem ele, PanResponder.
import React, { useMemo, useRef, useState } from 'react';
import { View, PanResponder } from 'react-native';
import { REA_OK, Rea, GH, RAnimated, runOnJS } from './rea';

const clampW = (v, a, b) => { 'worklet'; return Math.max(a, Math.min(b, v)); };

function ReaDrag({ minDx = -1e6, maxDx = 1e6, onStart, onEnd, onTap, onTouch, longPress = 0, style, children, hitSlop, enabled = true }) {
  const dx = Rea.useSharedValue(0);
  const active = Rea.useSharedValue(0);
  const cb = useRef({});
  cb.current = { onStart, onEnd, onTap, onTouch };
  const jsTouch = useMemo(() => (on) => cb.current.onTouch?.(on), []);
  const jsStart = useMemo(() => () => cb.current.onStart?.(), []);
  const jsEnd = useMemo(() => (v) => cb.current.onEnd?.(v), []);
  const jsTap = useMemo(() => () => cb.current.onTap?.(), []);
  const gesture = useMemo(() => {
    const G = GH.Gesture;
    let pan = G.Pan().enabled(enabled).activeOffsetX([-6, 6]).failOffsetY([-24, 24]);
    if (longPress > 0) pan = G.Pan().enabled(enabled).activateAfterLongPress(longPress);
    if (hitSlop) pan = pan.hitSlop(hitSlop);
    pan = pan
      .onBegin(() => { 'worklet'; runOnJS(jsTouch)(true); })
      .onStart(() => { 'worklet'; active.value = 1; runOnJS(jsStart)(); })
      .onUpdate((e) => { 'worklet'; dx.value = clampW(e.translationX, minDx, maxDx); })
      .onEnd(() => { 'worklet'; const v = dx.value; runOnJS(jsEnd)(v); })
      .onFinalize(() => { 'worklet'; dx.value = 0; active.value = 0; runOnJS(jsTouch)(false); });
    if (!onTap) return pan;
    const tap = G.Tap().maxDuration(300).onEnd((_e, ok) => { 'worklet'; if (ok) runOnJS(jsTap)(); });
    return G.Exclusive(pan, tap);
  }, [enabled, minDx, maxDx, longPress, hitSlop, !!onTap, jsStart, jsEnd, jsTap, jsTouch, dx, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const aStyle = Rea.useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { scale: active.value && longPress ? 1.08 : 1 }],
    zIndex: active.value ? 10 : 0,
  }));
  return (
    <GH.GestureDetector gesture={gesture}>
      <RAnimated.View style={[style, aStyle]}>{children}</RAnimated.View>
    </GH.GestureDetector>
  );
}

function PlainDrag({ minDx = -1e6, maxDx = 1e6, onStart, onEnd, onTap, onTouch, style, children, enabled = true }) {
  const [dx, setDx] = useState(0);
  const cb = useRef({});
  cb.current = { ...cb.current, onStart, onEnd, onTap, onTouch, minDx, maxDx };
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => enabled,
    onMoveShouldSetPanResponder: (_e, g) => enabled && Math.abs(g.dx) > 6,
    onPanResponderGrant: () => { cb.current.onTouch?.(true); },
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > 6 && !cb.current.started) { cb.current.started = true; cb.current.onStart?.(); }
      setDx(Math.max(cb.current.minDx, Math.min(cb.current.maxDx, g.dx)));
    },
    onPanResponderRelease: (_e, g) => {
      const v = Math.max(cb.current.minDx, Math.min(cb.current.maxDx, g.dx));
      const started = cb.current.started;
      cb.current.started = false;
      setDx(0);
      cb.current.onTouch?.(false);
      if (!started && Math.abs(g.dx) < 6) cb.current.onTap?.();
      else cb.current.onEnd?.(v);
    },
    onPanResponderTerminate: () => { cb.current.started = false; setDx(0); cb.current.onTouch?.(false); },
  }), [enabled]);
  return <View {...pr.panHandlers} style={[style, { transform: [{ translateX: dx }] }]}>{children}</View>;
}

export default REA_OK ? ReaDrag : PlainDrag;
