// MessageScreenEffect — full-screen overlay that plays once when a
// message arrives carrying a "screen" effect. Imperative API via ref:
//   screenEffectRef.current?.play('balloons');
//
// Choreography matches iMessage reference videos as closely as RN's
// Animated lets us:
//
//   • Echo       — five purple bubble copies ripple out from center,
//                  growing and fading.
//   • Spotlight  — vignette darkens the screen, a radial cone shines
//                  on the chat center, dust motes drift through the beam.
//   • Balloons   — 18 SVG balloons rise with sinusoidal sway, varied
//                  sizes/colors, slow stagger.
//   • Confetti   — 110 particles fall from above, mixed shapes
//                  (square / strip / rounded), random rotation rates.
//   • Love       — central heart bloom + 30 hearts rising in mixed
//                  sizes with pink glow.
//   • Lasers     — 8 neon beams sweep across in disco strobe with
//                  glow blur.
//   • Fireworks  — primary + secondary explosions, color-cycled,
//                  staggered across the upper screen.
//   • Celebration — fireworks + golden confetti + heart sparkles
//                   layered together, the "blowout" effect.
//
// Everything uses transform/opacity only so useNativeDriver:true holds
// 60 fps even on low-end Android.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Animated, Easing, StyleSheet, Dimensions, Platform } from 'react-native';
import Svg, { Path, Defs, RadialGradient, Stop, Circle, LinearGradient, Rect } from 'react-native-svg';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const rand = (min, max) => min + Math.random() * (max - min);

const SCREEN_EFFECTS = new Set([
  'echo', 'spotlight', 'balloons', 'confetti', 'love', 'lasers', 'fireworks', 'celebration',
  'shooting-star',
]);

// ── Public component ────────────────────────────────────────────────
const MessageScreenEffect = React.forwardRef(function MessageScreenEffect(_props, ref) {
  const [active, setActive] = useState(null);
  const flash = useRef(new Animated.Value(0)).current;

  const play = useCallback((effect) => {
    if (!effect || !SCREEN_EFFECTS.has(effect)) return;
    setActive({ id: effect, key: Date.now() });
    // Lasers + fireworks + celebration get a short white flash so the
    // first impression reads as "boom" not "particles appeared".
    if (effect === 'lasers' || effect === 'fireworks' || effect === 'celebration') {
      Animated.sequence([
        Animated.timing(flash, { toValue: 0.2, duration: 80, useNativeDriver: true }),
        Animated.timing(flash, { toValue: 0, duration: 240, useNativeDriver: true }),
      ]).start();
    }
    const ttl = effect === 'balloons' ? 5400
              : effect === 'spotlight' ? 2800
              : effect === 'celebration' ? 4400
              : effect === 'confetti' ? 3800
              : effect === 'love' ? 4000
              : effect === 'fireworks' ? 4200
              : effect === 'lasers' ? 2400
              : effect === 'echo' ? 2800
              : effect === 'shooting-star' ? 2600
              : 3400;
    setTimeout(() => setActive((cur) => (cur && cur.id === effect ? null : cur)), ttl);
  }, [flash]);

  React.useImperativeHandle(ref, () => ({ play }), [play]);

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <Animated.View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: '#fff', opacity: flash }]}
      />
      {active ? <RenderEffect key={active.key} effect={active.id} /> : null}
    </View>
  );
});

function RenderEffect({ effect }) {
  switch (effect) {
    case 'balloons': return <Balloons />;
    case 'confetti': return <Confetti golden={false} />;
    case 'celebration': return <Celebration />;
    case 'love': return <Love />;
    case 'fireworks': return <Fireworks />;
    case 'lasers': return <Lasers />;
    case 'spotlight': return <Spotlight />;
    case 'echo': return <Echo />;
    case 'shooting-star': return <ShootingStar />;
    default: return null;
  }
}

// ── Balloons ────────────────────────────────────────────────────────
function Balloons() {
  const COLORS = ['#EF4444', '#F59E0B', '#FACC15', '#10B981', '#3B82F6', '#A855F7', '#EC4899', '#06B6D4'];
  // iMessage-grade upgrade 2026-05-07: 18 → 28 balloons, broader staggering
  // so they fill the screen instead of clumping mid-anim.
  const balloons = useRef(
    Array.from({ length: 28 }).map((_, i) => ({
      x: rand(4, SCREEN_W - 60),
      delay: i * 70 + rand(0, 250),
      duration: rand(4000, 5400),
      sway: rand(6, 18),
      swayPeriod: rand(800, 1500),
      size: rand(34, 64),
      color: COLORS[i % COLORS.length],
    }))
  ).current;

  return (
    <>
      {balloons.map((b, i) => <Balloon key={i} {...b} />)}
    </>
  );
}

function Balloon({ x, delay, duration, sway, swayPeriod, size, color }) {
  const y = useRef(new Animated.Value(SCREEN_H + 80)).current;
  const swayV = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
        Animated.timing(y, {
          toValue: -size * 2,
          duration,
          useNativeDriver: true,
          easing: Easing.bezier(0.1, 0.5, 0.4, 1),
        }),
        Animated.loop(Animated.sequence([
          Animated.timing(swayV, { toValue: 1, duration: swayPeriod, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
          Animated.timing(swayV, { toValue: -1, duration: swayPeriod, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        ])),
      ]),
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [y, swayV, opacity, delay, duration, swayPeriod, size]);

  const tx = swayV.interpolate({ inputRange: [-1, 1], outputRange: [-sway, sway] });
  const stringH = size * 0.55;

  return (
    <Animated.View style={{
      position: 'absolute',
      left: x,
      opacity,
      transform: [{ translateY: y }, { translateX: tx }],
    }}>
      <Svg width={size} height={size * 1.45} viewBox="0 0 100 145">
        <Defs>
          <RadialGradient id={`bg-${color.slice(1)}`} cx="35%" cy="30%" r="65%">
            <Stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <Stop offset="0.5" stopColor={color} stopOpacity="1" />
            <Stop offset="1" stopColor={color} stopOpacity="0.85" />
          </RadialGradient>
        </Defs>
        <Path
          d="M50 4 C24 4 12 26 12 48 C12 72 28 92 50 96 C72 92 88 72 88 48 C88 26 76 4 50 4 Z"
          fill={`url(#bg-${color.slice(1)})`}
        />
        {/* knot */}
        <Path d="M44 96 L56 96 L52 102 L48 102 Z" fill={color} opacity="0.9" />
        {/* string */}
        <Path d={`M50 102 Q47 ${102 + stringH * 0.4} 51 ${102 + stringH * 0.7} Q55 ${102 + stringH} 50 ${102 + stringH}`}
          stroke="rgba(0,0,0,0.45)" strokeWidth="1" fill="none" />
      </Svg>
    </Animated.View>
  );
}

// ── Confetti ────────────────────────────────────────────────────────
function Confetti({ golden = false }) {
  const COLORS = golden
    ? ['#FACC15', '#F59E0B', '#FCD34D', '#FFFFFF', '#EAB308']
    : ['#EF4444', '#F59E0B', '#FACC15', '#10B981', '#3B82F6', '#A855F7', '#EC4899', '#06B6D4'];

  // iMessage-grade upgrade 2026-05-07: 110 → 180 particles, 4 shape variants
  // (circle / rect / strip / triangle), broader size range for parallax.
  const pieces = useRef(
    Array.from({ length: 180 }).map((_, i) => ({
      fromX: rand(0, SCREEN_W),
      drift: rand(-160, 160),
      duration: rand(2000, 3800),
      delay: rand(0, 1000),
      size: rand(5, 16),
      ratio: rand(0.35, 1), // strip vs square
      color: COLORS[i % COLORS.length],
      rotateSpeed: rand(2, 8),
      // 4 shapes — circle, square, strip (thin rect), triangle
      shape: ['circle', 'rect', 'strip', 'triangle'][i % 4],
    }))
  ).current;

  return <>{pieces.map((p, i) => <ConfettiPiece key={i} {...p} />)}</>;
}

function ConfettiPiece({ fromX, drift, duration, delay, size, ratio, color, rotateSpeed, shape }) {
  const t = useRef(new Animated.Value(0)).current;
  const r = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(t, { toValue: 1, duration, useNativeDriver: true, easing: Easing.bezier(0.2, 0.4, 0.4, 1) }),
      ]),
      Animated.loop(Animated.timing(r, {
        toValue: rotateSpeed, duration: duration, useNativeDriver: true, easing: Easing.linear,
      })),
    ]).start();
  }, [t, r, duration, delay, rotateSpeed]);

  const ty = t.interpolate({ inputRange: [0, 1], outputRange: [-30, SCREEN_H + 30] });
  const tx = t.interpolate({ inputRange: [0, 1], outputRange: [fromX, fromX + drift] });
  const op = t.interpolate({ inputRange: [0, 0.05, 0.9, 1], outputRange: [0, 1, 1, 0] });
  const rotate = r.interpolate({ inputRange: [0, 6], outputRange: ['0deg', '2160deg'] });

  // Per-shape geometry: circle uses size×size + full radius;
  // rect uses size×(size*ratio) + slight rounding (square-ish);
  // strip uses size×(size*0.25) — long thin ribbons;
  // triangle uses an SVG polygon for proper edges.
  if (shape === 'triangle') {
    return (
      <Animated.View style={{
        position: 'absolute',
        opacity: op,
        transform: [{ translateX: tx }, { translateY: ty }, { rotate }],
      }}>
        <Svg width={size + 2} height={size + 2} viewBox="0 0 10 10">
          <Path d="M5 0 L10 9 L0 9 Z" fill={color} />
        </Svg>
      </Animated.View>
    );
  }

  const isStrip = shape === 'strip';
  const style = {
    position: 'absolute',
    width: shape === 'circle' ? size : size,
    height: shape === 'circle' ? size : isStrip ? size * 0.25 : size * ratio,
    backgroundColor: color,
    borderRadius: shape === 'circle' ? size / 2 : isStrip ? 1 : 1.5,
    opacity: op,
    transform: [{ translateX: tx }, { translateY: ty }, { rotate }],
  };
  return <Animated.View style={style} />;
}

// ── Love ────────────────────────────────────────────────────────────
function Love() {
  const bloom = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(bloom, { toValue: 1, duration: 600, easing: Easing.out(Easing.back(2)), useNativeDriver: true }),
      Animated.delay(500),
      Animated.timing(bloom, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]).start();
  }, [bloom]);

  const hearts = useRef(
    Array.from({ length: 32 }).map((_, i) => ({
      x: rand(20, SCREEN_W - 40),
      delay: rand(0, 1100),
      duration: rand(2400, 3600),
      size: rand(18, 42),
      sway: rand(20, 50),
      color: i % 3 === 0 ? '#FB7185' : i % 3 === 1 ? '#EC4899' : '#F43F5E',
    }))
  ).current;

  // Big central bloom
  const bloomScale = bloom.interpolate({ inputRange: [0, 1], outputRange: [0.2, 2.2] });
  const bloomOp = bloom.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.85, 0] });

  return (
    <>
      <Animated.View style={{
        position: 'absolute',
        left: SCREEN_W / 2 - 60,
        top: SCREEN_H * 0.4,
        opacity: bloomOp,
        transform: [{ scale: bloomScale }],
      }}>
        <HeartShape size={120} color="#EC4899" glow />
      </Animated.View>
      {hearts.map((h, i) => <RisingHeart key={i} {...h} />)}
    </>
  );
}

function RisingHeart({ x, delay, duration, size, sway, color }) {
  const t = useRef(new Animated.Value(0)).current;
  const sw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(t, { toValue: 1, duration, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
      ]),
      Animated.loop(Animated.sequence([
        Animated.timing(sw, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(sw, { toValue: -1, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ])),
    ]).start();
  }, [t, sw, delay, duration]);

  const ty = t.interpolate({ inputRange: [0, 1], outputRange: [SCREEN_H - 60, -60] });
  const tx = sw.interpolate({ inputRange: [-1, 1], outputRange: [-sway, sway] });
  const op = t.interpolate({ inputRange: [0, 0.05, 0.85, 1], outputRange: [0, 0.95, 0.95, 0] });

  return (
    <Animated.View style={{
      position: 'absolute',
      left: x,
      opacity: op,
      transform: [{ translateY: ty }, { translateX: tx }],
    }}>
      <HeartShape size={size} color={color} />
    </Animated.View>
  );
}

function HeartShape({ size, color, glow = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {glow ? (
        <Defs>
          <RadialGradient id="heart-glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity="0.6" />
            <Stop offset="1" stopColor={color} stopOpacity="0" />
          </RadialGradient>
        </Defs>
      ) : null}
      {glow ? <Circle cx={12} cy={12} r={11} fill="url(#heart-glow)" /> : null}
      <Path
        d="M12 21s-7.5-4.5-9.5-9.5C1.5 8 4 5 7 5c2 0 3.5 1 5 3 1.5-2 3-3 5-3 3 0 5.5 3 4.5 6.5C19.5 16.5 12 21 12 21z"
        fill={color}
      />
    </Svg>
  );
}

// ── Lasers ──────────────────────────────────────────────────────────
function Lasers() {
  const beams = useRef([
    { color: '#EC4899', y: SCREEN_H * 0.2,  angle: 14,  delay: 0,    dir: 1 },
    { color: '#06B6D4', y: SCREEN_H * 0.32, angle: -22, delay: 80,   dir: -1 },
    { color: '#F59E0B', y: SCREEN_H * 0.45, angle: 30,  delay: 160,  dir: 1 },
    { color: '#A855F7', y: SCREEN_H * 0.55, angle: -18, delay: 240,  dir: -1 },
    { color: '#10B981', y: SCREEN_H * 0.68, angle: 24,  delay: 320,  dir: 1 },
    { color: '#FACC15', y: SCREEN_H * 0.78, angle: -28, delay: 400,  dir: -1 },
    { color: '#3B82F6', y: SCREEN_H * 0.88, angle: 16,  delay: 480,  dir: 1 },
    { color: '#EF4444', y: SCREEN_H * 0.15, angle: -10, delay: 560,  dir: -1 },
  ]).current;

  return <>{beams.map((b, i) => <LaserBeam key={i} {...b} />)}</>;
}

function LaserBeam({ color, y, angle, delay, dir }) {
  const t = useRef(new Animated.Value(0)).current;
  const strobe = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(t, { toValue: 1, duration: 1500, useNativeDriver: true, easing: Easing.bezier(0.3, 0, 0.6, 1) }),
        Animated.loop(Animated.sequence([
          Animated.timing(strobe, { toValue: 1, duration: 90, useNativeDriver: true }),
          Animated.timing(strobe, { toValue: 0.6, duration: 90, useNativeDriver: true }),
        ])),
      ]),
    ]).start();
  }, [t, strobe, delay]);

  const tx = t.interpolate({
    inputRange: [0, 1],
    outputRange: dir > 0 ? [-SCREEN_W, SCREEN_W * 1.5] : [SCREEN_W * 1.5, -SCREEN_W],
  });
  const op = Animated.multiply(
    t.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] }),
    strobe,
  );

  const beamStyle = {
    position: 'absolute',
    top: y,
    left: 0,
    width: SCREEN_W * 1.4,
    height: 3,
    backgroundColor: color,
    opacity: op,
    transform: [{ translateX: tx }, { rotate: `${angle}deg` }],
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 16px ${color}, 0 0 32px ${color}` } : {}),
    ...Platform.select({
      ios: { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 14 },
      android: { elevation: 8 },
      default: {},
    }),
  };
  return <Animated.View style={beamStyle} />;
}

// ── Fireworks ───────────────────────────────────────────────────────
// iMessage-grade upgrade 2026-05-07: 7 → 12 bursts, denser sparks (16-22 → 22-34),
// staggered across more screen + a couple of secondary smaller pops late.
function Fireworks() {
  const bursts = useRef([
    { x: SCREEN_W * 0.25, y: SCREEN_H * 0.25, color: '#F59E0B', delay: 0,    sparks: 28 },
    { x: SCREEN_W * 0.70, y: SCREEN_H * 0.20, color: '#EF4444', delay: 220,  sparks: 26 },
    { x: SCREEN_W * 0.50, y: SCREEN_H * 0.40, color: '#3B82F6', delay: 460,  sparks: 32 },
    { x: SCREEN_W * 0.18, y: SCREEN_H * 0.50, color: '#10B981', delay: 700,  sparks: 24 },
    { x: SCREEN_W * 0.80, y: SCREEN_H * 0.42, color: '#A855F7', delay: 940,  sparks: 28 },
    { x: SCREEN_W * 0.40, y: SCREEN_H * 0.18, color: '#EC4899', delay: 1180, sparks: 34 },
    { x: SCREEN_W * 0.60, y: SCREEN_H * 0.60, color: '#FACC15', delay: 1420, sparks: 28 },
    { x: SCREEN_W * 0.30, y: SCREEN_H * 0.62, color: '#06B6D4', delay: 1660, sparks: 24 },
    { x: SCREEN_W * 0.85, y: SCREEN_H * 0.55, color: '#FB7185', delay: 1900, sparks: 26 },
    // Late secondary pops — smaller bursts for trailing crackle
    { x: SCREEN_W * 0.15, y: SCREEN_H * 0.32, color: '#FFFFFF', delay: 2200, sparks: 14 },
    { x: SCREEN_W * 0.55, y: SCREEN_H * 0.30, color: '#FFFFFF', delay: 2400, sparks: 14 },
    { x: SCREEN_W * 0.78, y: SCREEN_H * 0.68, color: '#FFFFFF', delay: 2600, sparks: 14 },
  ]).current;

  return (
    <>
      {bursts.map((b, i) => <Firework key={i} {...b} />)}
    </>
  );
}

function Firework({ x, y, color, delay, sparks }) {
  const burst = useRef(new Animated.Value(0)).current;
  const flare = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(flare, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(burst, { toValue: 1, duration: 1300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
      ]),
    ]).start();
  }, [burst, flare, delay]);

  const flareOp = flare.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.9, 0] });
  const flareScale = flare.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.6] });

  return (
    <View style={{ position: 'absolute', left: x, top: y }}>
      {/* Flash core */}
      <Animated.View
        style={{
          position: 'absolute',
          left: -16, top: -16, width: 32, height: 32, borderRadius: 16,
          backgroundColor: '#fff',
          opacity: flareOp,
          transform: [{ scale: flareScale }],
        }}
      />
      {Array.from({ length: sparks }).map((_, i) => {
        const angle = (Math.PI * 2 * i) / sparks;
        const dist = 70 + Math.random() * 50;
        const dx = burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * dist] });
        const dy = burst.interpolate({
          inputRange: [0, 1],
          // Gravity: arc starts straight, then dips. Quadratic bezier
          // approximation via second outputRange entry's y bias.
          outputRange: [0, Math.sin(angle) * dist + 25],
        });
        const op = burst.interpolate({ inputRange: [0, 0.05, 0.85, 1], outputRange: [0, 1, 1, 0] });
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              width: 5, height: 5, borderRadius: 2.5,
              backgroundColor: color,
              opacity: op,
              transform: [{ translateX: dx }, { translateY: dy }],
              ...(Platform.OS === 'web' ? { boxShadow: `0 0 6px ${color}` } : {}),
            }}
          />
        );
      })}
    </View>
  );
}

// ── Spotlight ───────────────────────────────────────────────────────
function Spotlight() {
  const dim = useRef(new Animated.Value(0)).current;
  const cone = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(dim, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(cone, { toValue: 1, duration: 800, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
      ]),
      Animated.delay(900),
      Animated.parallel([
        Animated.timing(dim, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(cone, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]),
    ]).start();
  }, [dim, cone]);

  const motes = useRef(
    Array.from({ length: 16 }).map((_, i) => ({
      x: SCREEN_W / 2 - 100 + Math.random() * 200,
      y: SCREEN_H * 0.15 + Math.random() * SCREEN_H * 0.6,
      delay: i * 70,
      size: 2 + Math.random() * 2,
    }))
  ).current;

  const dimOpacity = dim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.7] });
  const coneOp = cone.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#000', opacity: dimOpacity }]} />
      <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: coneOp }]}>
        <Svg width={SCREEN_W} height={SCREEN_H} style={StyleSheet.absoluteFillObject}>
          <Defs>
            <RadialGradient id="cone" cx="50%" cy="40%" r="55%">
              <Stop offset="0" stopColor="#fff" stopOpacity="0.55" />
              <Stop offset="0.4" stopColor="#fff" stopOpacity="0.18" />
              <Stop offset="1" stopColor="#fff" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width={SCREEN_W} height={SCREEN_H} fill="url(#cone)" />
        </Svg>
      </Animated.View>
      {motes.map((m, i) => <DustMote key={i} {...m} />)}
    </>
  );
}

function DustMote({ x, y, delay, size }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.loop(Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 2000, useNativeDriver: true, easing: Easing.linear }),
        Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])),
    ]).start();
  }, [t, delay]);

  const ty = t.interpolate({ inputRange: [0, 1], outputRange: [0, -40] });
  const op = t.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.7, 0] });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: x, top: y,
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: '#fff',
        opacity: op,
        transform: [{ translateY: ty }],
      }}
    />
  );
}

// ── Echo ────────────────────────────────────────────────────────────
// iMessage-grade upgrade 2026-05-07: 5 → 14 bubble copies, varied sizes,
// drift in 3 directions (up + 2 angled), parallax fade, color cycling
// across the brand purple gradient. Each copy has its own delay/duration
// so the ripple feels organic instead of uniform.
function Echo() {
  const COPIES = 14;
  const PURPLES = ['#7C3AED', '#8B5CF6', '#A78BFA', '#9333EA', '#6D28D9'];
  const copies = useRef(
    Array.from({ length: COPIES }).map((_, i) => ({
      v: new Animated.Value(0),
      delay: i * 110 + rand(0, 80),
      duration: rand(1300, 1700),
      // 3 angles: -30°, 0°, +30° (in radians) — staggered so screen fills
      angle: ((i % 3) - 1) * (Math.PI / 6),
      // Distance the bubble travels from the start point
      distance: rand(140, 220),
      // Bubble width varies for parallax
      width: rand(110, 200),
      color: PURPLES[i % PURPLES.length],
      // Start offset from center so they don't all collapse on origin
      offsetX: rand(-30, 30),
      offsetY: rand(-20, 20),
    }))
  ).current;

  useEffect(() => {
    Animated.parallel(copies.map((c) =>
      Animated.sequence([
        Animated.delay(c.delay),
        Animated.timing(c.v, { toValue: 1, duration: c.duration, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
      ])
    )).start();
  }, [copies]);

  return (
    <View style={StyleSheet.absoluteFillObject}>
      {copies.map((c, i) => {
        const scale = c.v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.7] });
        // Travel along the angle: dx = cos(angle) * dist, dy = sin(angle) * dist - vertical bias
        const tx = c.v.interpolate({
          inputRange: [0, 1],
          outputRange: [c.offsetX, c.offsetX + Math.sin(c.angle) * c.distance],
        });
        const ty = c.v.interpolate({
          inputRange: [0, 1],
          outputRange: [c.offsetY, c.offsetY - c.distance * 0.85],
        });
        const op = c.v.interpolate({ inputRange: [0, 0.12, 0.85, 1], outputRange: [0, 0.78, 0.45, 0] });
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              left: SCREEN_W / 2 - c.width / 2,
              top: SCREEN_H / 2,
              width: c.width, height: 42,
              borderRadius: 21,
              backgroundColor: c.color,
              opacity: op,
              transform: [{ translateX: tx }, { translateY: ty }, { scale }],
              ...(Platform.OS === 'web' ? { boxShadow: `0 4px 16px ${c.color}55` } : {}),
            }}
          />
        );
      })}
    </View>
  );
}

// ── Shooting Star (NEW 2026-05-07) ──────────────────────────────────
// Single large star with glowing trail crosses the screen diagonally,
// followed by a sparkle burst at the impact point. Echoes iMessage's
// "shooting star" sub-effect that lands once and feels weighty.
function TrailDot({ delay, size, startX, endX, startY, endY }) {
  const trT = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.timing(trT, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
    ]).start();
  }, [trT, delay]);
  const trX = trT.interpolate({ inputRange: [0, 1], outputRange: [startX, endX] });
  const trY = trT.interpolate({ inputRange: [0, 1], outputRange: [startY, endY] });
  const trOp = trT.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 0.7, 0.3, 0] });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: '#FFF8DC',
        opacity: trOp,
        transform: [{ translateX: trX }, { translateY: trY }],
        ...(Platform.OS === 'web' ? { boxShadow: '0 0 12px #FFD700' } : {}),
      }}
    />
  );
}

function ShootingStar() {
  const t = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
      Animated.timing(burst, { toValue: 1, duration: 800, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
    ]).start();
  }, [t, burst]);

  // Travel from upper-left to lower-right
  const startX = -80;
  const endX = SCREEN_W + 40;
  const startY = SCREEN_H * 0.18;
  const endY = SCREEN_H * 0.62;

  const tx = t.interpolate({ inputRange: [0, 1], outputRange: [startX, endX] });
  const ty = t.interpolate({ inputRange: [0, 1], outputRange: [startY, endY] });
  const op = t.interpolate({ inputRange: [0, 0.05, 0.85, 1], outputRange: [0, 1, 1, 0.2] });
  const scale = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.6, 1.2, 0.8] });

  // Trail particles
  const trail = useRef(
    Array.from({ length: 14 }).map((_, i) => ({
      delay: i * 45,
      size: 4 + i * 0.3,
    }))
  ).current;

  // Burst sparks at landing point
  const sparks = useRef(
    Array.from({ length: 18 }).map((_, i) => ({
      angle: (Math.PI * 2 * i) / 18,
      dist: rand(40, 80),
    }))
  ).current;

  return (
    <View style={StyleSheet.absoluteFillObject}>
      {/* Trail dots — extracted to TrailDot component to keep hooks stable */}
      {trail.map((tr, i) => (
        <TrailDot key={i} {...tr} startX={startX} endX={endX} startY={startY} endY={endY} />
      ))}
      {/* Main star */}
      <Animated.View
        style={{
          position: 'absolute',
          opacity: op,
          transform: [{ translateX: tx }, { translateY: ty }, { scale }],
        }}
      >
        <Svg width={50} height={50} viewBox="0 0 24 24">
          <Defs>
            <RadialGradient id="star-glow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#FFD700" stopOpacity="0.9" />
              <Stop offset="1" stopColor="#FFD700" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={12} cy={12} r={11} fill="url(#star-glow)" />
          <Path
            d="M12 2l2.6 7h7.4l-6 4.5 2.3 7L12 16l-6.3 4.5 2.3-7-6-4.5h7.4z"
            fill="#FFD700"
            stroke="#FFA500"
            strokeWidth="0.5"
          />
        </Svg>
      </Animated.View>
      {/* Burst sparks at endpoint */}
      {sparks.map((s, i) => {
        const dx = burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(s.angle) * s.dist] });
        const dy = burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(s.angle) * s.dist] });
        const sop = burst.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 0.95, 0.5, 0] });
        return (
          <Animated.View
            key={`s-${i}`}
            style={{
              position: 'absolute',
              left: endX - 25,
              top: endY,
              width: 4, height: 4, borderRadius: 2,
              backgroundColor: '#FFD700',
              opacity: sop,
              transform: [{ translateX: dx }, { translateY: dy }],
              ...(Platform.OS === 'web' ? { boxShadow: '0 0 8px #FFD700' } : {}),
            }}
          />
        );
      })}
    </View>
  );
}

// ── Celebration ─────────────────────────────────────────────────────
function Celebration() {
  // Layered: central firework + golden confetti + a few rising hearts.
  // Order matters for z: confetti goes underneath the firework so the
  // burst pops on top.
  return (
    <>
      <Confetti golden />
      <View style={StyleSheet.absoluteFillObject}>
        <Firework x={SCREEN_W / 2} y={SCREEN_H * 0.32} color="#FACC15" delay={0} sparks={26} />
        <Firework x={SCREEN_W * 0.25} y={SCREEN_H * 0.45} color="#F59E0B" delay={500} sparks={18} />
        <Firework x={SCREEN_W * 0.75} y={SCREEN_H * 0.45} color="#EAB308" delay={500} sparks={18} />
      </View>
    </>
  );
}

// ── Live preview (for the "Send with Effect" composer) ──────────────
// Reuses the EXACT per-effect renderers above (RenderEffect → Balloons /
// Confetti / Love / …) so the preview matches what the recipient sees
// pixel-for-pixel. Unlike the imperative <MessageScreenEffect> overlay,
// this one auto-replays on a loop: each effect runs once, then after a
// short rest the `key` bumps and RenderEffect remounts, restarting all the
// inner Animated sequences. Switching `effect` also bumps the key so the
// new effect plays immediately. All timers are cleared on unmount / effect
// change so nothing leaks.
//
//   <ScreenEffectPreview effect="balloons" active />
//
// `active=false` tears everything down (used when the preview area is
// hidden) so we don't run Animated loops behind a closed sheet.
function ScreenEffectPreview({ effect, active = true }) {
  const [cycle, setCycle] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!active || !effect || !SCREEN_EFFECTS.has(effect)) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return undefined;
    }
    // Per-effect run length (mirrors the TTLs the real overlay uses), plus a
    // brief pause so the loop reads as "replay" not "stutter".
    const ttl = effect === 'balloons' ? 5400
              : effect === 'spotlight' ? 2800
              : effect === 'celebration' ? 4400
              : effect === 'confetti' ? 3800
              : effect === 'love' ? 4000
              : effect === 'fireworks' ? 4200
              : effect === 'lasers' ? 2400
              : effect === 'echo' ? 2800
              : effect === 'shooting-star' ? 2600
              : 3400;
    const REST = 700;

    let cancelled = false;
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        setCycle((c) => c + 1); // remount RenderEffect → restart animation
        schedule();
      }, ttl + REST);
    };
    schedule();

    return () => {
      cancelled = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    // `effect` change resets cycle below; including it here restarts the loop
    // with the new effect's timing.
  }, [effect, active]);

  // When the chosen effect changes, reset to cycle 0 so the new effect's
  // first run starts clean (and the key below changes → fresh mount).
  useEffect(() => { setCycle(0); }, [effect]);

  if (!active || !effect || !SCREEN_EFFECTS.has(effect)) return null;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <RenderEffect key={`${effect}-${cycle}`} effect={effect} />
    </View>
  );
}

export default MessageScreenEffect;
export { ScreenEffectPreview };
export const SCREEN_EFFECT_IDS = SCREEN_EFFECTS;
