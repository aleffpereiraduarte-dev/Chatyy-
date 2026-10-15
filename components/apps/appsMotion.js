// [2026-10-15 apps-motion] Motion do painel de Apps — WEB.
//
// Mesma API do appsMotion.native.js, mas 100% CSS/compositor (nenhum loop JS):
//   • AppsItem   — entrada em cascata (keyframes c/ animationDelay) + FLIP via
//                  Web Animations API quando a busca reorganiza a grade (mede
//                  offsetTop/Left relativo ao pai → imune ao scroll);
//   • Jiggle     — tremor "modo editar" do iPhone (keyframes infinitos);
//   • Pop        — pop de badge / tecla limpar (keyframes, re-dispara por key);
//   • TilePress  — micro-bounce no toque (transition CSS no transform).
// prefers-reduced-motion (useReducedMotion) → tudo estático.
import React, { useLayoutEffect, useRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useReducedMotion } from '../reducedMotion';

export const APPS_MOTION_ENGINE = 'css';
export function prepareLayoutChange() {}

const kf = StyleSheet.create({
  enter: {
    animationKeyframes: [{
      '0%': { opacity: 0, transform: 'translateY(14px) scale(0.92)' },
      '60%': { opacity: 1, transform: 'translateY(-1px) scale(1.015)' },
      '100%': { opacity: 1, transform: 'translateY(0px) scale(1)' },
    }],
    animationDuration: '520ms',
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'both',
  },
  pop: {
    animationKeyframes: [{
      '0%': { transform: 'scale(0.3)', opacity: 0 },
      '55%': { transform: 'scale(1.18)', opacity: 1 },
      '80%': { transform: 'scale(0.96)' },
      '100%': { transform: 'scale(1)', opacity: 1 },
    }],
    animationDuration: '420ms',
    animationTimingFunction: 'cubic-bezier(0.3, 0.9, 0.4, 1)',
    animationFillMode: 'both',
  },
  jiggle: {
    animationKeyframes: [{
      '0%': { transform: 'rotate(-1.6deg)' },
      '100%': { transform: 'rotate(1.6deg)' },
    }],
    animationDuration: '260ms',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    animationDirection: 'alternate',
  },
});

// Grid/section item. enterDelay (ms) = cascata; 0 = item que surgiu pela busca.
export function AppsItem({ enterDelay = 0, style, children, testID }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const prev = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.offsetTop !== 'number') return;
    const pos = { x: el.offsetLeft, y: el.offsetTop };
    const p = prev.current;
    prev.current = pos;
    if (!p || reduce || typeof el.animate !== 'function') return;
    const dx = p.x - pos.x; const dy = p.y - pos.y;
    if (!dx && !dy) return;
    try {
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
        { duration: 420, easing: 'cubic-bezier(0.2, 1.15, 0.35, 1)' },
      );
    } catch {}
  });
  return (
    <View
      ref={ref}
      testID={testID}
      style={[style, !reduce && kf.enter, !reduce && { animationDelay: `${Math.max(0, enterDelay | 0)}ms` }]}
    >
      {children}
    </View>
  );
}

export function Jiggle({ active, seed = 0, children, style }) {
  const reduce = useReducedMotion();
  const on = !!active && !reduce;
  return (
    <View style={[style, on && kf.jiggle, on && { animationDelay: `-${(seed * 97) % 260}ms`, animationDuration: `${240 + (seed % 3) * 20}ms` }]}>
      {children}
    </View>
  );
}

// popKey muda → re-monta → keyframe dispara de novo.
export function Pop({ popKey, style, children }) {
  const reduce = useReducedMotion();
  return <View key={String(popKey)} style={[style, !reduce && kf.pop]}>{children}</View>;
}

export function TilePress({ onPress, onLongPress, delayLongPress, scaleTo = 0.9, style, children, ...rest }) {
  const reduce = useReducedMotion();
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={delayLongPress} {...rest}>
      {({ pressed }) => (
        <View
          style={[style, {
            transform: [{ scale: pressed && !reduce ? scaleTo : 1 }],
            transitionProperty: 'transform',
            transitionDuration: pressed ? '120ms' : '360ms',
            transitionTimingFunction: pressed ? 'ease-out' : 'cubic-bezier(0.3, 1.6, 0.5, 1)',
            cursor: 'pointer',
          }]}
        >
          {children}
        </View>
      )}
    </Pressable>
  );
}
