// [2026-10-14 motion] Cabeçalho da conversa: quando a linha "online / visto há…"
// chega DEPOIS da 1ª pintura (presença do WS), o bloco nome+status centralizado
// subia ~8 px num frame (medido no web: título dy −8). Aqui o bloco nasce no
// lugar antigo (translateY +meia linha, aplicado antes da pintura) e desliza
// com mola até o novo; a linha nova entra com fade. Se a linha SAI, o inverso.
// Sem motion (flag/Reduzir movimento) = troca seca.
import React, { useLayoutEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { MOTION_ND, motionOn } from './motionFlag';

export default function HeaderStackReveal({ hasSub, subHeight = 17, style, children }) {
  const ty = useRef(new Animated.Value(0)).current;
  const prev = useRef(hasSub);
  useLayoutEffect(() => {
    if (prev.current === hasSub) return;
    prev.current = hasSub;
    if (!motionOn()) { ty.setValue(0); return; }
    // conteúdo centralizado: a linha nova de altura h move o bloco h/2
    ty.setValue((hasSub ? 1 : -1) * (subHeight / 2));
    Animated.spring(ty, { toValue: 0, stiffness: 320, damping: 30, mass: 1, useNativeDriver: MOTION_ND }).start();
  }, [hasSub, subHeight, ty]);
  return <Animated.View style={[style, { transform: [{ translateY: ty }] }]}>{children}</Animated.View>;
}
