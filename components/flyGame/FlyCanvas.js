// components/flyGame/FlyCanvas.js — [voar 2026-10-22] tela de desenho do Brisa.
// Nativo: Skia (já no binário desde a 2.5.0) — a cada quadro o laço JS avança o motor e grava um SkPicture
// (services/flyGame/renderer.js) que vai para o <Picture> por shared value do Reanimated (sem re-render React).
// Kill: globalThis.__chatyy_fly_sv === false → o quadro vai por estado React (mais lento, mas sem Reanimated).
// Web: <canvas> 2D com o MESMO desenho (canvas2dPainter). Sem Skia no binário (nunca deveria) → onUnavailable().
// Toque: onTouchStart (o mais cedo possível no JS) → runner.tap(); o motor aplica no próximo tick.
import React, { useEffect, useRef, useState } from 'react';
import { View, Platform, TurboModuleRegistry } from 'react-native';
import { canvas2dPainter, skiaPainter } from '../../services/flyGame/renderer';

let _sk; // undefined = não sondado; null = indisponível (mesma guarda do BiaOrb/studioEngine)
export function getFlySkia() {
  if (_sk !== undefined) return _sk;
  _sk = null;
  if (Platform.OS === 'web') return null;
  try {
    let present = global.SkiaApi != null;
    if (!present) { try { present = !!(TurboModuleRegistry?.get && TurboModuleRegistry.get('RNSkiaModule')); } catch { present = false; } }
    if (!present) return null;
    const mod = require('@shopify/react-native-skia'); // eslint-disable-line global-require
    if (mod?.Skia && mod?.Canvas && mod?.Picture && mod?.TileMode) _sk = mod;
  } catch { _sk = null; }
  return _sk;
}
export function flyCanvasSupported() { return Platform.OS === 'web' || !!getFlySkia(); }

function useLoop(runnerRef, paused, draw) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    if (paused) return undefined;
    let raf = 0; let last = 0; let alive = true;
    const tick = (now) => {
      if (!alive) return;
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const r = runnerRef.current;
      if (r) { try { r.frame(dt); drawRef.current(r); } catch (e) { /* um quadro ruim não derruba o jogo */ } }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [paused, runnerRef]);
}

function SkiaFly({ Sk, runnerRef, width, height, paused }) {
  const { Canvas, Picture, Skia, TileMode } = Sk;
  const Rea = require('react-native-reanimated'); // eslint-disable-line global-require
  const useSV = globalThis.__chatyy_fly_sv !== false;
  const empty = useRef(null);
  if (!empty.current) { const rec = Skia.PictureRecorder(); rec.beginRecording(Skia.XYWHRect(0, 0, 1, 1)); empty.current = rec.finishRecordingAsPicture(); }
  const pic = Rea.useSharedValue(empty.current);
  const [picState, setPicState] = useState(empty.current);
  const cache = useRef({});
  useLoop(runnerRef, paused, (r) => {
    const rec = Skia.PictureRecorder();
    const c = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));
    r.draw(skiaPainter(Skia, TileMode, c, cache.current), { w: width, h: height });
    const p = rec.finishRecordingAsPicture();
    if (useSV) pic.value = p; else setPicState(p);
  });
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      <Picture picture={useSV ? pic : picState} />
    </Canvas>
  );
}

function WebFly({ runnerRef, width, height, paused }) {
  const ref = useRef(null);
  const P = useRef(null);
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr);
    P.current = canvas2dPainter(cv.getContext('2d'));
  }, [width, height, dpr]);
  useLoop(runnerRef, paused, (r) => {
    const cv = ref.current; if (!cv || !P.current) return;
    const ctx = cv.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0);
    r.draw(P.current, { w: cv.width, h: cv.height });
  });
  return React.createElement('canvas', { ref, style: { width, height, display: 'block', touchAction: 'none' } });
}

export default function FlyCanvas({ runnerRef, width, height, paused, onTap, style }) {
  const Sk = getFlySkia();
  if (!width || !height) return <View style={style} />;
  const onTouchStart = (e) => { try { onTap && onTap(e); } catch {} };
  return (
    <View style={[{ width, height, overflow: 'hidden', backgroundColor: '#141A24' }, style]} onTouchStart={Platform.OS === 'web' ? undefined : onTouchStart}
      {...(Platform.OS === 'web' ? { onStartShouldSetResponder: () => true, onResponderGrant: onTouchStart } : null)}
      accessible accessibilityRole="button" accessibilityLabel="Brisa" accessibilityHint="Toque para voar">
      {Platform.OS === 'web' ? <WebFly runnerRef={runnerRef} width={width} height={height} paused={paused} />
        : (Sk ? <SkiaFly Sk={Sk} runnerRef={runnerRef} width={width} height={height} paused={paused} /> : null)}
    </View>
  );
}
