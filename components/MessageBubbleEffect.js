// MessageBubbleEffect — replays an iMessage bubble effect once on first
// render of a tagged message. Physics tuned to match Apple's reference:
//   • Slam   — bubble drops from 4× size, hard spring overshoot, dust
//              shockwave ring + a brief screen shake on impact, rotation kick.
//   • Loud   — pulses to 1.8×, violent lateral shake, two ripple rings
//              expand and fade.
//   • Gentle — bubble whispers in from 0.35× with full opacity ramp,
//              long 1.4 s ease-out so it feels handed not thrown.
//   • Invisible Ink — multi-layered shimmering particles (3 sizes, mixed
//              colors) sit over the content until tapped to reveal.
//
// PLAYED is a module-level Set so scrolling away and back never replays
// an effect — same model iMessage uses (Apple records "shown" once).
//
// The exact same choreography hook (useBubbleEffectAnim) drives BOTH the
// recipient playback AND the live preview in the picker (BubbleEffectPreview),
// so what the sender previews is pixel-identical to what the recipient sees.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Animated, Easing, View, TouchableWithoutFeedback, StyleSheet } from 'react-native';

const PLAYED = new Set();
const BUBBLE_EFFECTS = new Set(['slam', 'loud', 'gentle', 'invisible-ink']);

// ── Optional global screen-shake bus ────────────────────────────────
// Slam shakes the whole conversation, not just the bubble. The chat screen
// can register a listener (registerShakeSink) and apply the emitted intensity
// to a wrapping Animated.View. If nothing is registered the bubble still gets
// its own local shake, so this is a progressive enhancement (never required).
let shakeSink = null;
export function registerShakeSink(fn) {
  shakeSink = typeof fn === 'function' ? fn : null;
  return () => { if (shakeSink === fn) shakeSink = null; };
}
function emitScreenShake(intensity = 1) {
  try { shakeSink && shakeSink(intensity); } catch {}
}

// ── Shared choreography hook ─────────────────────────────────────────
// Drives the Animated values for a single play-through of a bubble effect.
// `play()` runs the animation; `reset()` snaps values back to rest. The
// preview component loops play()→delay→reset; the recipient calls play() once.
function useBubbleEffectAnim(effect) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const rot = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  // Slam dust shockwave + Loud ripples reuse these (only one effect runs at a
  // time per bubble, so sharing keeps the GPU layer count low).
  const shockwave = useRef(new Animated.Value(0)).current;
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;
  const localShake = useRef(new Animated.Value(0)).current;
  const runningRef = useRef(null);

  const reset = useCallback(() => {
    runningRef.current?.stop?.();
    scale.setValue(1); tx.setValue(0); ty.setValue(0); rot.setValue(0);
    opacity.setValue(1); shockwave.setValue(0); ripple1.setValue(0);
    ripple2.setValue(0); localShake.setValue(0);
  }, [scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2, localShake]);

  const play = useCallback((onDone) => {
    runningRef.current?.stop?.();
    let anim = null;

    if (effect === 'slam') {
      // Bubble drops from 4× size with a rotation kick + hard settle, then a
      // dust shockwave ring expands AFTER landing (~220 ms) so it reads as the
      // impact. On the same frame we fire a short screen shake (global if a
      // sink is registered, otherwise a local damped wobble).
      scale.setValue(4); ty.setValue(-90); rot.setValue(-0.05);
      opacity.setValue(0.2); shockwave.setValue(0); localShake.setValue(0);
      anim = Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, tension: 140, friction: 7, useNativeDriver: true }),
        Animated.spring(ty, { toValue: 0, tension: 140, friction: 7, useNativeDriver: true }),
        Animated.spring(rot, { toValue: 0, tension: 130, friction: 6, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(210),
          Animated.parallel([
            Animated.timing(shockwave, {
              toValue: 1, duration: 560,
              easing: Easing.out(Easing.cubic), useNativeDriver: true,
            }),
            // Damped impact wobble: 4 decaying swings then rest.
            Animated.sequence([
              Animated.timing(localShake, { toValue: 1, duration: 45, useNativeDriver: true }),
              Animated.timing(localShake, { toValue: -0.7, duration: 45, useNativeDriver: true }),
              Animated.timing(localShake, { toValue: 0.4, duration: 45, useNativeDriver: true }),
              Animated.timing(localShake, { toValue: -0.2, duration: 45, useNativeDriver: true }),
              Animated.timing(localShake, { toValue: 0, duration: 45, useNativeDriver: true }),
            ]),
          ]),
        ]),
      ]);
      // Screen-wide shake on the landing frame.
      setTimeout(() => emitScreenShake(1), 200);
    } else if (effect === 'loud') {
      // Pulse big then shake while shrinking back. Two ripple rings fire
      // 120 ms apart so they form a "shouted out" stagger.
      scale.setValue(1); tx.setValue(0); ripple1.setValue(0); ripple2.setValue(0);
      anim = Animated.sequence([
        Animated.timing(scale, { toValue: 1.85, duration: 220, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
        Animated.parallel([
          Animated.sequence([
            Animated.timing(tx, { toValue: -13, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 13, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: -11, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 9, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: -6, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 3, duration: 48, useNativeDriver: true }),
            Animated.timing(tx, { toValue: 0, duration: 48, useNativeDriver: true }),
          ]),
          Animated.spring(scale, { toValue: 1, tension: 110, friction: 6, useNativeDriver: true }),
          Animated.timing(ripple1, {
            toValue: 1, duration: 720,
            easing: Easing.out(Easing.cubic), useNativeDriver: true,
          }),
          Animated.sequence([
            Animated.delay(120),
            Animated.timing(ripple2, {
              toValue: 1, duration: 720,
              easing: Easing.out(Easing.cubic), useNativeDriver: true,
            }),
          ]),
        ]),
      ]);
    } else if (effect === 'gentle') {
      // Whisper in: tiny + invisible, ease up to full size + opacity over
      // ~1.4 s. Cubic-bezier matches Apple's "easeOutQuint" feel.
      scale.setValue(0.32); opacity.setValue(0);
      anim = Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1, duration: 900,
          easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1, duration: 1400,
          easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true,
        }),
      ]);
    }

    if (!anim) { onDone?.(); return; }
    runningRef.current = anim;
    anim.start(({ finished }) => { if (finished) onDone?.(); });
  }, [effect, scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2, localShake]);

  useEffect(() => () => { runningRef.current?.stop?.(); }, []);

  return { scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2, localShake, play, reset };
}

// ── Decorative rings (shared by recipient + preview) ─────────────────
function SlamRing({ shockwave }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -22, right: -22, top: -12, bottom: -12,
        borderRadius: 44,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.85)',
        opacity: shockwave.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.65, 0] }),
        transform: [{ scale: shockwave.interpolate({ inputRange: [0, 1], outputRange: [0.55, 2.4] }) }],
      }}
    />
  );
}

function LoudRings({ ripple1, ripple2 }) {
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -16, right: -16, top: -10, bottom: -10,
          borderRadius: 40, borderWidth: 3,
          borderColor: 'rgba(124,58,237,0.7)',
          opacity: ripple1.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.7, 0] }),
          transform: [{ scale: ripple1.interpolate({ inputRange: [0, 1], outputRange: [0.85, 2.4] }) }],
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -16, right: -16, top: -10, bottom: -10,
          borderRadius: 40, borderWidth: 2,
          borderColor: 'rgba(124,58,237,0.5)',
          opacity: ripple2.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] }),
          transform: [{ scale: ripple2.interpolate({ inputRange: [0, 1], outputRange: [0.85, 2.6] }) }],
        }}
      />
    </>
  );
}

export default function MessageBubbleEffect({ effect, messageId, isOwn, children }) {
  const validEffect = effect && BUBBLE_EFFECTS.has(effect) ? effect : null;
  const key = `${messageId || 'tmp'}_${validEffect || 'none'}`;

  const { scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2, localShake, play } =
    useBubbleEffectAnim(validEffect);

  useEffect(() => {
    if (!validEffect || validEffect === 'invisible-ink') return;
    if (PLAYED.has(key)) return;
    PLAYED.add(key);
    play();
  }, [key, validEffect, play]);

  if (!validEffect) {
    return children;
  }

  if (validEffect === 'invisible-ink') {
    return <InvisibleInkBubble messageId={messageId}>{children}</InvisibleInkBubble>;
  }

  // localShake adds a tiny lateral jitter on the slam impact frame so the
  // bubble itself feels the hit even when no global shake sink is registered.
  const shakeX = localShake.interpolate({ inputRange: [-1, 1], outputRange: [-5, 5] });
  const transform = [
    { scale },
    { translateX: Animated.add(tx, shakeX) },
    { translateY: ty },
    { rotate: rot.interpolate({ inputRange: [-1, 1], outputRange: ['-1rad', '1rad'] }) },
  ];

  return (
    <View style={{ position: 'relative' }}>
      {validEffect === 'slam' ? <SlamRing shockwave={shockwave} /> : null}
      {validEffect === 'loud' ? <LoudRings ripple1={ripple1} ripple2={ripple2} /> : null}
      <Animated.View style={{ transform, opacity }}>
        {children}
      </Animated.View>
    </View>
  );
}

// ── Live preview (picker bubble tab) ─────────────────────────────────
// Reuses the EXACT useBubbleEffectAnim choreography + ring renderers so the
// sender's preview matches the recipient pixel-for-pixel. Loops: play once,
// rest, reset, repeat. `active=false` stops the loop (sheet closed / tab
// switched away) so we don't burn Animated cycles behind a closed sheet.
export function BubbleEffectPreview({ effect, active = true, color = '#7C3AED', label = 'Olá' }) {
  const validEffect = effect && BUBBLE_EFFECTS.has(effect) ? effect : null;
  const anim = useBubbleEffectAnim(validEffect === 'invisible-ink' ? null : validEffect);
  const { scale, tx, ty, rot, opacity, shockwave, ripple1, ripple2, localShake, play, reset } = anim;
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);
  // Invisible-ink preview just shimmers a mask in/out on a loop.
  const inkMask = useRef(new Animated.Value(1)).current;
  const inkLoopRef = useRef(null);

  useEffect(() => {
    cancelledRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    inkLoopRef.current?.stop?.();

    if (!active || !validEffect) {
      reset();
      return () => {};
    }

    if (validEffect === 'invisible-ink') {
      inkMask.setValue(1);
      inkLoopRef.current = Animated.loop(Animated.sequence([
        Animated.timing(inkMask, { toValue: 0.15, duration: 700, useNativeDriver: true }),
        Animated.delay(500),
        Animated.timing(inkMask, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.delay(300),
      ]));
      inkLoopRef.current.start();
      return () => { cancelledRef.current = true; inkLoopRef.current?.stop?.(); };
    }

    const REST = validEffect === 'gentle' ? 700 : 900;
    const loop = () => {
      if (cancelledRef.current) return;
      play(() => {
        if (cancelledRef.current) return;
        timerRef.current = setTimeout(() => {
          if (cancelledRef.current) return;
          reset();
          // tiny gap so reset commits before the next play
          timerRef.current = setTimeout(loop, 60);
        }, REST);
      });
    };
    loop();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      reset();
    };
  }, [active, validEffect, play, reset, inkMask]);

  const shakeX = localShake.interpolate({ inputRange: [-1, 1], outputRange: [-5, 5] });

  const bubble = (
    <View style={{
      backgroundColor: color,
      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18,
      borderBottomRightRadius: 6,
    }}>
      <Animated.Text style={{
        color: '#fff', fontSize: 14, fontWeight: '600',
        opacity: validEffect === 'invisible-ink' ? inkMask.interpolate({ inputRange: [0.15, 1], outputRange: [1, 0.06] }) : 1,
      }}>
        {label}
      </Animated.Text>
    </View>
  );

  if (validEffect === 'invisible-ink') {
    return (
      <View style={{ position: 'relative', alignSelf: 'flex-end' }}>
        {bubble}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, {
            opacity: inkMask, borderRadius: 18, borderBottomRightRadius: 6,
            backgroundColor: '#1a1a2e', overflow: 'hidden',
          }]}
        >
          <InvisibleInkParticles count={36} />
        </Animated.View>
      </View>
    );
  }

  const transform = [
    { scale },
    { translateX: Animated.add(tx, shakeX) },
    { translateY: ty },
    { rotate: rot.interpolate({ inputRange: [-1, 1], outputRange: ['-1rad', '1rad'] }) },
  ];

  return (
    <View style={{ position: 'relative', alignSelf: 'flex-end' }}>
      {validEffect === 'slam' ? <SlamRing shockwave={shockwave} /> : null}
      {validEffect === 'loud' ? <LoudRings ripple1={ripple1} ripple2={ripple2} /> : null}
      <Animated.View style={{ transform, opacity }}>
        {bubble}
      </Animated.View>
    </View>
  );
}

// iMessage-grade Invisible Ink: dark noise overlay fully hides the bubble
// until tapped. Reveal fades the mask out + text in over 320ms. After 12s
// the mask re-applies (matching Apple's auto-re-hide on inactivity) so the
// "secret" feel persists across re-reads. Tap toggles instantly.
function InvisibleInkBubble({ messageId, children }) {
  // We track revealed state internally; PLAYED registers the message-id so
  // returning to the conversation after scrolling away preserves the
  // revealed state for the session (otherwise it'd re-mask every render).
  const revealedKey = `inkRevealed_${messageId || 'tmp'}`;
  const [revealed, setRevealed] = useState(() => PLAYED.has(revealedKey));
  const maskOpacity = useRef(new Animated.Value(revealed ? 0 : 1)).current;
  const textOpacity = useRef(new Animated.Value(revealed ? 1 : 0)).current;
  const reHideTimer = useRef(null);

  const reveal = () => {
    if (reHideTimer.current) { clearTimeout(reHideTimer.current); reHideTimer.current = null; }
    setRevealed(true);
    PLAYED.add(revealedKey);
    Animated.parallel([
      Animated.timing(maskOpacity, { toValue: 0, duration: 320, useNativeDriver: true }),
      Animated.timing(textOpacity, { toValue: 1, duration: 320, useNativeDriver: true }),
    ]).start();
    // Auto-re-hide after 12s (iMessage parity). User can tap again to reveal.
    reHideTimer.current = setTimeout(() => {
      setRevealed(false);
      PLAYED.delete(revealedKey);
      Animated.parallel([
        Animated.timing(maskOpacity, { toValue: 1, duration: 420, useNativeDriver: true }),
        Animated.timing(textOpacity, { toValue: 0, duration: 280, useNativeDriver: true }),
      ]).start();
    }, 12000);
  };

  useEffect(() => () => {
    if (reHideTimer.current) clearTimeout(reHideTimer.current);
  }, []);

  return (
    <TouchableWithoutFeedback onPress={revealed ? undefined : reveal}>
      <View style={{ position: 'relative' }}>
        {/* Layer 1: the message bubble, opacity-controlled. We render it
            even when masked so the bubble takes its real size — particles
            then fill that real size via absoluteFill on layer 2. */}
        <Animated.View style={{ opacity: textOpacity }}>
          {children}
        </Animated.View>
        {/* Layer 2: full-opacity dark mask + animated particles. Fades to 0
            on reveal. pointerEvents='none' lets the outer Touchable handle
            taps from anywhere in the bubble area. */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, {
            opacity: maskOpacity,
            borderRadius: 18,
            backgroundColor: '#1a1a2e',
            overflow: 'hidden',
          }]}
        >
          <InvisibleInkParticles />
        </Animated.View>
      </View>
    </TouchableWithoutFeedback>
  );
}

function InvisibleInkParticles({ count = 90 }) {
  // Independent particles with brownian-style fade cycles approximate
  // iMessage's GL noise without the GPU cost. Sizes 2–6px on a high-DPI
  // screen actually read as visible glitter. Bias toward white with a 30%
  // chance of pale-violet for the iMessage "fizz" sparkle.
  const passes = useRef(
    Array.from({ length: count }).map(() => ({
      v: new Animated.Value(Math.random()),
      size: 2 + Math.random() * 4,        // 2–6 px
      duration: 350 + Math.random() * 850,
      color: Math.random() > 0.7
        ? 'rgba(210,210,255,1)'  // pale violet sparkle (30%)
        : 'rgba(255,255,255,1)', // bright white (70%)
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
