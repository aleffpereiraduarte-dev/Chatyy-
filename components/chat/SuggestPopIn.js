// components/chat/SuggestPopIn.js — [2026-10-16 motion-composer]
//
// Casca das sugestões acima do compositor (menções @, comandos /bot): ao
// aparecer sobe 12px + fade + escala 0.97→1 com mola (Telegram), ancorada no
// rodapé (fica "saindo" do compositor). RN Animated com native driver (UI
// thread, sem re-render). Mesmo `style` da View que substitui.
//
// Reduzir Movimento (SO ou app) → aparece estática. Kill switch OTA:
// globalThis.__chatyy_motion_suggest = false → View comum (comportamento antigo).
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, View } from 'react-native';
import { isReduceMotionEnabled } from '../reducedMotion';

function _off() {
  try { if (globalThis.__chatyy_motion_suggest === false) return true; } catch {}
  try { if (globalThis.__chatyy_motion === false) return true; } catch {}
  try { return !!isReduceMotionEnabled(); } catch { return false; }
}

const _ND = Platform.OS !== 'web';

function SuggestPopInAnimated({ style, children, ...rest }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.spring(v, { toValue: 1, damping: 20, stiffness: 320, mass: 0.8, useNativeDriver: _ND });
    a.start();
    return () => { try { a.stop(); } catch {} };
  }, [v]);
  const anim = {
    opacity: v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
    transform: [
      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
    ],
  };
  return <Animated.View {...rest} style={[style, anim]}>{children}</Animated.View>;
}

export default function SuggestPopIn(props) {
  // Lido só no mount: a casca não troca de tipo enquanto está na tela.
  const offRef = useRef(null);
  if (offRef.current === null) offRef.current = _off();
  if (offRef.current) {
    const { children, ...rest } = props;
    return <View {...rest}>{children}</View>;
  }
  return <SuggestPopInAnimated {...props} />;
}
