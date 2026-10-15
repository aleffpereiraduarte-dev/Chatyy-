// [2026-10-14 motion] Entra/sai com mola (Telegram): monta com scale+translate+
// fade e, ao `visible=false`, anima a saída ANTES de desmontar (o antigo
// `{cond && <X/>}` sumia seco). Native driver; sem motion = aparece/some seco.
//   <SpringPresence visible={show} from={{ translateY: 12, scale: 0.6 }}>…</SpringPresence>
import React, { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { MOTION_ND, motionOn, SPRING_FAB } from './motionFlag';

export default function SpringPresence({ visible, children, from = { translateY: 12, scale: 0.6 }, spring = SPRING_FAB, exitMs = 160, pointerEvents = 'box-none', style }) {
  const [mounted, setMounted] = useState(!!visible);
  const v = useRef(new Animated.Value(0)).current;
  const animRef = useRef(null);
  useEffect(() => {
    if (visible && !mounted) { setMounted(true); return undefined; } // anima depois de montar (nó nativo já ligado)
    if (animRef.current) { try { animRef.current.stop(); } catch {} animRef.current = null; }
    if (visible) {
      if (!motionOn()) { v.setValue(1); return undefined; }
      const a = Animated.spring(v, { toValue: 1, ...spring, useNativeDriver: MOTION_ND });
      animRef.current = a; a.start();
    } else if (mounted) {
      if (!motionOn()) { v.setValue(0); setMounted(false); return undefined; }
      const a = Animated.timing(v, { toValue: 0, duration: exitMs, useNativeDriver: MOTION_ND });
      animRef.current = a;
      a.start(({ finished }) => { if (finished) setMounted(false); });
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mounted]);
  if (!mounted) return null;
  const ty = from.translateY || 0; const sc = from.scale == null ? 1 : from.scale;
  return (
    <Animated.View pointerEvents={visible ? pointerEvents : 'none'} style={[style, {
      opacity: v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
      transform: [
        { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [ty, 0] }) },
        { scale: v.interpolate({ inputRange: [0, 1], outputRange: [sc, 1] }) },
      ],
    }]}>
      {children}
    </Animated.View>
  );
}
