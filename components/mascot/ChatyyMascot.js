// components/mascot/ChatyyMascot.js — [2026-10-16 mascote] Mascote ORIGINAL
// do Chatyy (balão de conversa com carinha) animado em camadas.
//
// Como anima: cada parte (sombra, braços, corpo, olhos, lupa, extras) é um
// <Svg> próprio dentro de um Animated.View; UM valor mestre `t` (0→1, loop
// linear) dirige todas as camadas via interpolate → transform/opacity.
// useNativeDriver no iOS/Android (zero custo no JS thread); no web, JS.
// Pivôs via `transformOrigin` (RN ≥ 0.73 / react-native-web).
//
// Poses: 'wave' (acenar), 'sleep' (dormir), 'search' (procurar com lupa),
// 'celebrate' (comemorar com confete), 'offline' (sem internet).
// Reduzir movimento → quadro estático (sem loop), igual em todas.
//
// 100% JS (react-native-svg + Animated) → chega por OTA, sem build.
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Animated, Easing, Platform, StyleSheet } from 'react-native';
import Svg, { Path, Circle, Ellipse, Rect, G } from 'react-native-svg';
import { useReducedMotion } from '../reducedMotion';
import { ART, MASCOT_COLORS as MC } from './mascotArt';

const ND = Platform.OS !== 'web';
const VB = `0 0 ${ART.size} ${ART.size}`;
const pct = (v) => `${(v / ART.size) * 100}%`;
const origin = (x, y) => `${pct(x)} ${pct(y)}`;

// Ciclo (ms) e quadro estático (t) por pose.
const POSES = {
  wave: { ms: 2400, still: 0 },
  sleep: { ms: 3600, still: 0.3 },
  search: { ms: 2800, still: 0.25 },
  celebrate: { ms: 1700, still: 0.42 },
  offline: { ms: 3200, still: 0.25 },
};

// interpolate a partir de pares [t, valor]
function kf(t, pairs, suffix) {
  const inputRange = pairs.map((p) => p[0]);
  const outputRange = pairs.map((p) => (suffix ? `${p[1]}${suffix}` : p[1]));
  return t.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}
// senoide amostrada (n ciclos dentro de 0..1)
function sine(amp, cycles = 1, phase = 0, base = 0) {
  const out = [];
  const N = 16 * cycles;
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    out.push([x, base + amp * Math.sin(2 * Math.PI * (x * cycles + phase))]);
  }
  return out;
}

function Layer({ style, children, size }) {
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox={VB}>{children}</Svg>
    </Animated.View>
  );
}

/**
 * <ChatyyMascot pose="wave" size={140} dark={isDark} />
 * props: pose, size (px), dark (contornos externos claros no tema escuro),
 *        paused (congela no quadro estático), style.
 */
function ChatyyMascot({ pose = 'wave', size = 140, dark = false, paused = false, style }) {
  const reduce = useReducedMotion();
  const P = POSES[pose] ? pose : 'wave';
  const cfg = POSES[P];
  const t = useRef(new Animated.Value(cfg.still)).current;
  const k = size / ART.size; // px por unidade do viewBox
  const still = reduce || paused;

  useEffect(() => {
    if (still) { t.stopAnimation(); t.setValue(cfg.still); return undefined; }
    t.setValue(0);
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: cfg.ms, easing: Easing.linear, useNativeDriver: ND }));
    loop.start();
    return () => loop.stop();
  }, [still, P, cfg.ms, cfg.still, t]);

  const ink = MC.ink;
  const fill = dark ? MC.fillDark : MC.fill;
  const outer = dark ? '#F5F5F7' : MC.ink; // traços FORA do corpo (zzz, wifi, sombra)

  const A = useMemo(() => {
    const u = (pairs) => pairs.map(([x, v]) => [x, v * k]); // unidades → px
    const blink = kf(t, [[0, 1], [0.6, 1], [0.63, 0.1], [0.66, 1], [1, 1]]);
    switch (P) {
      case 'wave': return {
        bodyY: kf(t, u(sine(-1.6, 2))),
        shadowX: kf(t, sine(-0.04, 2, 0, 1)),
        armR: kf(t, [[0, 0], [0.06, -18], [0.14, 10], [0.22, -18], [0.30, 10], [0.38, -18], [0.48, 0], [1, 0]], 'deg'),
        lines: kf(t, [[0, 0], [0.06, 1], [0.40, 1], [0.48, 0], [1, 0]]),
        eyesY: blink,
      };
      case 'sleep': return {
        bodyS: kf(t, sine(0.03, 1, 0, 1.0)),
        shadowX: kf(t, sine(0.03, 1, 0, 1.0)),
        z: [0, 1, 2].map((i) => {
          const a = i * 0.22; const b = a + 0.62;
          return {
            op: kf(t, [[0, 0], [a, 0], [a + 0.12, 1], [b - 0.12, 1], [b, 0], [1, 0]]),
            y: kf(t, u([[0, 6], [a, 6], [b, -4], [1, -4]])),
          };
        }),
      };
      case 'search': {
        const gx = [[0, 0], [0.25, -9], [0.5, -4], [0.75, 3], [1, 0]];
        const gy = [[0, 0], [0.25, -2], [0.5, 2], [0.75, -1.5], [1, 0]];
        return {
          bodyY: kf(t, u(sine(-1, 2))),
          shadowX: kf(t, sine(-0.03, 2, 0, 1)),
          glassX: kf(t, u(gx)), glassY: kf(t, u(gy)),
          eyesX: kf(t, u(gx.map(([x, v]) => [x, v * 0.35]))),
          eyesY: blink,
        };
      }
      case 'celebrate': return {
        bodyY: kf(t, u([[0, 0], [0.1, 1.5], [0.38, -8], [0.6, 0], [0.68, 1.2], [0.78, 0], [1, 0]])),
        bodyS: kf(t, [[0, 1], [0.1, 0.95], [0.3, 1.03], [0.6, 1], [0.68, 0.97], [0.78, 1], [1, 1]]),
        shadowX: kf(t, [[0, 1], [0.38, 0.8], [0.6, 1], [1, 1]]),
        armR: kf(t, [[0, 0], [0.38, -16], [0.6, 8], [0.8, -6], [1, 0]], 'deg'),
        armL: kf(t, [[0, 0], [0.38, 16], [0.6, -8], [0.8, 6], [1, 0]], 'deg'),
        cA: kf(t, [[0, 0.4], [0.3, 1.15], [0.55, 1], [0.8, 0.4], [1, 0.4]]),
        cAo: kf(t, [[0, 0], [0.22, 1], [0.6, 1], [0.8, 0], [1, 0]]),
        cB: kf(t, [[0, 1], [0.2, 0.4], [0.5, 0.4], [0.8, 1.15], [1, 1]]),
        cBo: kf(t, [[0, 1], [0.2, 0], [0.55, 0], [0.75, 1], [1, 1]]),
      };
      case 'offline': default: return {
        bodyR: kf(t, sine(3, 1), 'deg'),
        shadowX: kf(t, sine(0.04, 1, 0.25, 0.98)),
        wifiY: kf(t, u(sine(-2, 1))),
        wifiO: kf(t, sine(0.3, 1, 0, 0.7)),
        eyesY: blink,
      };
    }
  }, [P, t, k]);

  const sw = ART.bodyStroke;
  const ex = { stroke: ink, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' };

  // ── partes ──
  const arm = (a, rot) => (
    <Layer size={size} style={{ transformOrigin: origin(a.pivot[0], a.pivot[1]), transform: rot ? [{ rotate: rot }] : [] }}>
      {dark ? <Path d={a.arm} fill="none" stroke={MC.fill} strokeWidth={sw + 4.6} strokeLinecap="round" /> : null}
      {dark ? <Path d={a.hand} fill={MC.fill} stroke={MC.fill} strokeWidth={sw + 3.5} strokeLinejoin="round" /> : null}
      <Path d={a.arm} fill="none" {...ex} strokeWidth={sw + 0.6} />
      <Path d={a.hand} fill={fill} {...ex} strokeWidth={sw - 0.5} />
      {a.fingers.map((d, i) => <Path key={i} d={d} fill="none" stroke={ink} strokeWidth={1.8} strokeLinecap="round" />)}
    </Layer>
  );

  const mouth = (() => {
    const M = ART.mouth;
    if (P === 'wave' || P === 'celebrate') return (
      <G>
        <Path d={M.open} fill={ink} stroke={ink} strokeWidth={1.4} strokeLinejoin="round" />
        <Path d={M.tongue} fill={MC.tongue} />
      </G>
    );
    if (P === 'sleep') return <Ellipse cx={M.o.cx} cy={M.o.cy} rx={M.o.rx} ry={M.o.ry} fill="none" stroke={ink} strokeWidth={2.4} />;
    if (P === 'search') return <Path d={M.small} fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" />;
    return <Path d={M.wavy} fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" />;
  })();

  const eyes = P === 'sleep' ? (
    <Layer size={size}>
      {ART.sleepEyes.map((d, i) => <Path key={i} d={d} fill="none" stroke={ink} strokeWidth={2.8} strokeLinecap="round" />)}
    </Layer>
  ) : (
    <Layer
      size={size}
      style={{
        transformOrigin: origin(ART.eyesCenter[0], ART.eyesCenter[1]),
        transform: [
          ...(A.eyesX ? [{ translateX: A.eyesX }] : []),
          ...(P === 'offline' ? [{ translateY: 1.6 * k }] : []),
          ...(A.eyesY ? [{ scaleY: A.eyesY }] : []),
        ],
      }}
    >
      {ART.eyes.map((e, i) => <Ellipse key={i} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={ink} />)}
      {ART.eyeShine.map((e, i) => <Circle key={i} cx={e.cx} cy={e.cy} r={e.r} fill="#FFFFFF" />)}
    </Layer>
  );

  const bodyTransform = [];
  if (A.bodyY) bodyTransform.push({ translateY: A.bodyY });
  if (A.bodyR) bodyTransform.push({ rotate: A.bodyR });
  if (A.bodyS) bodyTransform.push({ scaleY: A.bodyS });

  const confetti = (list, sc, op) => (
    <Layer size={size} style={{ opacity: op, transform: [{ scale: sc }] }}>
      {list.map((c, i) => (c.t === 'c'
        ? <Circle key={i} cx={c.x} cy={c.y} r={c.r} fill={MC.confetti[c.c]} />
        : <Rect key={i} x={c.x - c.w / 2} y={c.y - c.h / 2} width={c.w} height={c.h} rx={1.4} fill={MC.confetti[c.c]} transform={`rotate(${c.rot} ${c.x} ${c.y})`} />))}
    </Layer>
  );

  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
      {/* sombra no chão */}
      <Layer size={size} style={{ opacity: 1, transformOrigin: origin(ART.shadow.cx, ART.shadow.cy), transform: [{ scaleX: A.shadowX || 1 }] }}>
        <Ellipse cx={ART.shadow.cx} cy={ART.shadow.cy} rx={ART.shadow.rx} ry={ART.shadow.ry} fill={outer} opacity={dark ? 0.16 : ART.shadow.op} />
      </Layer>

      {P === 'celebrate' && confetti(ART.confettiB, A.cB, A.cBo)}

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transformOrigin: origin(60, 98), transform: bodyTransform }]}>
        {/* braços atrás do corpo (ombro escondido) */}
        {(P === 'wave' || P === 'celebrate') && arm(ART.armR, A.armR)}
        {P === 'celebrate' && arm(ART.armL, A.armL)}
        {P === 'wave' && (
          <Layer size={size} style={{ opacity: A.lines, transformOrigin: origin(ART.armR.pivot[0], ART.armR.pivot[1]), transform: [{ rotate: A.armR }] }}>
            {ART.armR.lines.map((d, i) => <Path key={i} d={d} fill="none" stroke={outer} strokeWidth={2.4} strokeLinecap="round" />)}
          </Layer>
        )}
        <Layer size={size}>
          {/* tema escuro: contorno branco "recortado" (figurinha) p/ a tinta não sumir no fundo preto */}
          {dark ? <Path d={ART.body} fill={MC.fill} stroke={MC.fill} strokeWidth={sw + 4} strokeLinejoin="round" /> : null}
          <Path d={ART.body} fill={fill} {...ex} />
          {ART.cheeks.map((c, i) => <Ellipse key={i} cx={c.cx} cy={c.cy} rx={c.rx} ry={c.ry} fill={MC.blush} opacity={ART.cheekOp} />)}
          {mouth}
        </Layer>
        {eyes}
        {P === 'search' && (
          <Layer size={size} style={{ transform: [{ translateX: A.glassX }, { translateY: A.glassY }] }}>
            {dark ? <Path d={`${ART.magnifier.arm} ${ART.magnifier.handle}`} fill="none" stroke={MC.fill} strokeWidth={sw + 4.6} strokeLinecap="round" /> : null}
            <Path d={ART.magnifier.arm} fill="none" {...ex} strokeWidth={sw + 0.4} />
            <Path d={ART.magnifier.handle} fill="none" {...ex} strokeWidth={sw + 1.6} />
            <Circle cx={ART.magnifier.lens.cx} cy={ART.magnifier.lens.cy} r={ART.magnifier.lens.r} fill={MC.lens} fillOpacity={0.28} {...ex} />
            <Path d={`M${ART.magnifier.lens.cx - 6} ${ART.magnifier.lens.cy - 2.5} Q${ART.magnifier.lens.cx - 5} ${ART.magnifier.lens.cy - 6} ${ART.magnifier.lens.cx - 1.5} ${ART.magnifier.lens.cy - 7}`} fill="none" stroke="#FFFFFF" strokeWidth={1.8} strokeLinecap="round" />
            <Circle cx={ART.magnifier.hand.cx} cy={ART.magnifier.hand.cy} r={ART.magnifier.hand.r} fill={fill} {...ex} strokeWidth={sw - 0.3} />
          </Layer>
        )}
      </Animated.View>

      {P === 'sleep' && A.z && ART.zs.map((z, i) => (
        <Layer key={i} size={size} style={{ opacity: A.z[i].op, transform: [{ translateY: A.z[i].y }] }}>
          <Path d={z.d} fill="none" stroke={outer} strokeWidth={z.w} strokeLinecap="round" strokeLinejoin="round" />
        </Layer>
      ))}
      {P === 'celebrate' && confetti(ART.confettiA, A.cA, A.cAo)}
      {P === 'offline' && (
        <Layer size={size} style={{ opacity: A.wifiO, transform: [{ translateY: A.wifiY }] }}>
          {ART.wifiOff.arcs.map((d, i) => <Path key={i} d={d} fill="none" stroke={outer} strokeWidth={2.6} strokeLinecap="round" />)}
          <Circle cx={ART.wifiOff.dot.cx} cy={ART.wifiOff.dot.cy} r={ART.wifiOff.dot.r} fill={outer} />
          <Path d={ART.wifiOff.slash} fill="none" stroke={outer} strokeWidth={2.6} strokeLinecap="round" />
        </Layer>
      )}
    </View>
  );
}

export default React.memo(ChatyyMascot);

// ─── figurinha de saudação (Lottie) ─────────────────────────────────────────
// Arquivos gerados por scripts/build-mascot-lottie.js em public/stickers/ →
// servidos em https://chatyy.com.br/stickers/ (vão junto no deploy web).
export const MASCOT_STICKER_BASE = 'https://chatyy.com.br/stickers/';
export const MASCOT_GREETING_URL = `${MASCOT_STICKER_BASE}chatyy-aceno.json`;
export const MASCOT_GREETING_PNG = `${MASCOT_STICKER_BASE}chatyy-aceno.png`;
const _STICKER_POSE = { aceno: 'wave', festa: 'celebrate' };
/** URL de figurinha Lottie do mascote → pose ('wave'…) ou null. */
export function mascotPoseFromUrl(u) {
  const m = /\/stickers\/chatyy-([a-z]+)\.json(?:[?#].*)?$/i.exec(String(u || ''));
  return m ? (_STICKER_POSE[m[1].toLowerCase()] || null) : null;
}
