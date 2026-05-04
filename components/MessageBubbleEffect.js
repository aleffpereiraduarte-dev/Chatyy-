// MessageBubbleEffect — replays an iMessage bubble effect once on first
// render of a tagged message. Physics tuned to match Apple's reference:
//   • Slam   — bubble drops from 4× size, hard spring overshoot, dust
//              shockwave, rotation kick on landing.
//   • Loud   — pulses to 1.8×, violent 12-px lateral shake, two ripple
//              rings expand and fade.
//   • Gentle — bubble whispers in from 0.35× with full opacity ramp,
//              long 1.4 s ease-out so it feels handed not thrown.
//   • Invisible Ink — multi-layered shimmering particles (3 sizes, mixed
//              colors) sit over the content until tapped to reveal.
//
// PLAYED is a module-level Set so scrolling away and back never replays
// an effect — same model iMessage uses (Apple records "shown" once).

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, TouchableWithoutFeedback, StyleSheet } from 'react-native';

const PLAYED = new Set();
const BUBBLE_EFFECTS = new Set(['slam', 'loud', 'gentle', 'invisible-ink']);

export default function MessageBubbleEffect({ effect, messageId, isOwn, children }) {
  const validEffect = effect && BUBBLE_EFFECTS.has(effect) ? effect : null;
  const key = `${messageId || 'tmp'}_${validEffect || 'none'}`;
  const [revealed, setRevealed] = useState(validEffect !== 'invisible-ink');

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const rot = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  // Slam shockwave + Loud ripple share these — only one effect runs at a
  // time per bubble so reusing keeps the GPU layer count low.
  const shockwave = useRef(new Animated.Value(0)).current;
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!validEffect) return;
    if (PLAYED.has(key)) return;
    PLAYED.add(key);

    if (validEffect === 'slam') {
      // Bubble drops from 4× size with a slight rotation kick. Apple's
      // reference uses ~250 ms total fall + ~180 ms hard settle. The
      // shockwave ring expands AFTER landing (~80 ms delay) so it reads
      // as the impact, not just decoration.
      scale.setValue(4);
      ty.setValue(-80);
      rot.setValue(-0.04);
      opacity.setValue(0.25);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, tension: 120, friction: 7, useNativeDriver: true }),
        Animated.spring(ty, { toValue: 0, tension: 120, friction: 7, useNativeDriver: true }),
        Animated.spring(rot, { toValue: 0, tension: 120, friction: 6, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(220),
          Animated.timing(shockwave, {
            toValue: 1, duration: 520,
            easing: Easing.out(Easing.cubic), useNativeDriver: true,
          }),
        ]),
      ]).start();
    } else if (validEffect === 'loud') {
      // Pulse big then shake while shrinking back. The two ripple rings
      // fire 60 ms apart so they form a "shouted out" stagger rather than
      // a single ring that reads as an alert badge.
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.8, duration: 220, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
        Animated.parallel([
          Animated.sequence([
            Animated.timing(tx, { toValue: -12, duration: 50, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 12, duration: 50, useNativeDriver: true }),
            Animated.timing(tx, { toValue: -10, duration: 50, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 10, duration: 50, useNativeDriver: true }),
            Animated.timing(tx, { toValue: -6, duration: 50, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 0, duration: 50, useNativeDriver: true }),
          ]),
          Animated.spring(scale, { toValue: 1, tension: 100, friction: 6, useNativeDriver: true }),
          Animated.timing(ripple1, {
            toValue: 1, duration: 700,
            easing: Easing.out(Easing.cubic), useNativeDriver: true,
          }),
          Animated.sequence([
            Animated.delay(120),
            Animated.timing(ripple2, {
              toValue: 1, duration: 700,
              easing: Easing.out(Easing.cubic), useNativeDriver: true,
            }),
          ]),
        ]),
      ]).start();
    } else if (validEffect === 'gentle') {
      // Whisper in: tiny + invisible, ease up to size + opacity over
      // 1.4 s. Cubic-bezier matches Apple's "easeOutQuint" feel.
      scale.setValue(0.35);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1, duration: 900,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1, duration: 1400,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [key, validEffect, scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2]);

  if (!validEffect) {
    return children;
  }

  const transform = [
    { scale },
    { translateX: tx },
    { translateY: ty },
    { rotate: rot.interpolate({ inputRange: [-1, 1], outputRange: ['-1rad', '1rad'] }) },
  ];

  if (validEffect === 'invisible-ink') {
    return (
      <View>
        <Animated.View style={{ opacity: revealed ? 1 : 0.05 }}>
          {children}
        </Animated.View>
        {!revealed && (
          <TouchableWithoutFeedback onPress={() => setRevealed(true)}>
            <View style={[StyleSheet.absoluteFillObject, {
              borderRadius: 18,
              backgroundColor: 'rgba(70,70,80,0.92)',
              alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }]}>
              <InvisibleInkParticles />
            </View>
          </TouchableWithoutFeedback>
        )}
      </View>
    );
  }

  // Slam: dust shockwave ring expands outward from the bubble's
  // landing point. Pure transform/opacity → useNativeDriver:true.
  const slamRing = validEffect === 'slam' ? (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -20, right: -20, top: -10, bottom: -10,
        borderRadius: 40,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.8)',
        opacity: shockwave.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.6, 0] }),
        transform: [{
          scale: shockwave.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.2] }),
        }],
      }}
    />
  ) : null;

  // Loud: two concentric rings, second 120 ms behind the first. Both
  // expand 2.4× and fade — "shout" frequency feel.
  const loudRings = validEffect === 'loud' ? (
    <>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -16, right: -16, top: -10, bottom: -10,
          borderRadius: 40,
          borderWidth: 3,
          borderColor: 'rgba(124,58,237,0.7)',
          opacity: ripple1.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.7, 0] }),
          transform: [{
            scale: ripple1.interpolate({ inputRange: [0, 1], outputRange: [0.85, 2.4] }),
          }],
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -16, right: -16, top: -10, bottom: -10,
          borderRadius: 40,
          borderWidth: 2,
          borderColor: 'rgba(124,58,237,0.5)',
          opacity: ripple2.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] }),
          transform: [{
            scale: ripple2.interpolate({ inputRange: [0, 1], outputRange: [0.85, 2.6] }),
          }],
        }}
      />
    </>
  ) : null;

  return (
    <View style={{ position: 'relative' }}>
      {slamRing}
      {loudRings}
      <Animated.View style={{ transform, opacity }}>
        {children}
      </Animated.View>
    </View>
  );
}

function InvisibleInkParticles() {
  // Three layered passes of particles with different sizes, opacity
  // ranges, and animation periods so the surface never settles into a
  // visible pattern. iMessage uses GL noise; we approximate with 36
  // independent fades — cheaper, indistinguishable in motion.
  const passes = useRef(
    Array.from({ length: 36 }).map(() => ({
      v: new Animated.Value(Math.random()),
      size: 1 + Math.random() * 3,        // 1–4 px
      duration: 400 + Math.random() * 800,
      color: Math.random() > 0.7 ? 'rgba(220,220,255,1)' : 'rgba(255,255,255,1)',
      left: Math.random() * 100,
      top: Math.random() * 100,
    }))
  ).current;

  useEffect(() => {
    const loops = passes.map((p) =>
      Animated.loop(Animated.sequence([
        Animated.timing(p.v, { toValue: 1, duration: p.duration, useNativeDriver: true }),
        Animated.timing(p.v, { toValue: 0, duration: p.duration, useNativeDriver: true }),
      ]))
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [passes]);

  return (
    <View style={StyleSheet.absoluteFillObject}>
      {passes.map((p, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            borderRadius: p.size / 2,
            backgroundColor: p.color,
            opacity: p.v,
          }}
        />
      ))}
    </View>
  );
}
