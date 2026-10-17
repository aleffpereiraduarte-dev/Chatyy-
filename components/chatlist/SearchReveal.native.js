// components/chatlist/SearchReveal.native.js — [2026-10-16 motion-nav]
// Barra de busca da home (app/chat.js) abrindo/fechando com MOLA na UI thread.
// Antes: Animated.Value com useNativeDriver:false (altura 0↔52 interpolada na
// thread JS a cada frame — sync/decrypt na JS = engasgo) + fechamento em
// timing 220 ms. Agora a altura, a opacidade e um leve "desce do header" do
// campo rodam em worklet; a lista abaixo recua junto (layout na UI thread) e
// reabrir no meio do fechamento inverte a mola (interrompível).
// OTA SAFETY: só com Reanimated já carregado (utils/threadKeyboard); kill
// switch globalThis.__chatyy_motion_search = false → caminho antigo do chat.js.
// Reduzir Movimento → abre/fecha sem animar.
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
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
  && Rea.withSpring && Rea.runOnJS && Rea.cancelAnimation
);
const AView = REA_OK ? Rea.default.View : View;
const withSpring = REA_OK ? Rea.withSpring : null;
const runOnJS = REA_OK ? Rea.runOnJS : null;
const cancelAnimation = REA_OK ? Rea.cancelAnimation : null;
const useSharedValue = REA_OK ? Rea.useSharedValue : null;
const useAnimatedStyle = REA_OK ? Rea.useAnimatedStyle : null;

// ζ ≈ 0,87: abre "assentando" sem quicar a lista; fecha sem passar de 0.
// Tokens locais (constants/motion* é do agente de micro-interações).
const OPEN_SPRING = { damping: 30, stiffness: 300, mass: 1 };
const CLOSE_SPRING = { damping: 30, stiffness: 340, mass: 1, overshootClamping: true };

export function searchRevealEnabled() {
  if (!REA_OK) return false;
  try { if (globalThis.__chatyy_motion_search === false) return false; } catch {}
  return true;
}

export function SearchReveal({ shown, height = 52, onHidden, style, children }) {
  const p = useSharedValue(0);
  const hiddenRef = useRef(onHidden);
  hiddenRef.current = onHidden;
  const firstRef = useRef(true);

  useEffect(() => {
    const fire = () => { try { hiddenRef.current?.(); } catch {} };
    const first = firstRef.current;
    firstRef.current = false;
    if (first && !shown) return; // montagem fechada: nada a fazer
    if (isReduceMotionEnabled()) {
      cancelAnimation(p);
      p.value = shown ? 1 : 0;
      if (!shown) fire();
      return;
    }
    if (shown) {
      p.value = withSpring(1, OPEN_SPRING);
    } else {
      p.value = withSpring(0, CLOSE_SPRING, (finished) => {
        'worklet';
        if (finished) runOnJS(fire)();
      });
    }
  }, [shown, p]);

  const outer = useAnimatedStyle(() => {
    const v = p.value < 0 ? 0 : p.value;
    return {
      height: v * height,
      opacity: v <= 0.5 ? 0 : (v >= 1 ? 1 : (v - 0.5) * 2),
    };
  });
  const inner = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - (p.value > 1 ? 1 : p.value)) * -10 }],
  }));

  return (
    <AView style={[style, outer]}>
      <AView style={inner}>{children}</AView>
    </AView>
  );
}
