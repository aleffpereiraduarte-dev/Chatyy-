// [2026-10-18 elegance] SelectionCheck — círculo de seleção múltipla estilo
// Telegram/iOS: ao marcar, o preenchimento "brota" do centro com mola (escala
// 0.5→1 + fade) e o check entra logo atrás; ao desmarcar, some rápido (120 ms).
//
//   <SelectionCheck on={selected} size={22} onColor={ink} offColor={g.tertiary}
//                   checkColor={onInk} />
//
// Drop-in no lugar do <View style={checkbox}>{on && <IconCheck/>}</View> que as
// listas usavam (troca seca de fundo). Primeira renderização NÃO anima (a lista
// abre já no estado certo). Reduzir Movimento / kill switch de motion = troca
// seca. Só RN Animated + react-native-svg → OTA-safe, funciona no web.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Springs, motionEnabled } from '../../constants/motion';

const ND = Platform.OS !== 'web';

function SelectionCheck({
  on = false,
  size = 22,
  borderWidth = 1.5,
  onColor = '#111111',
  offColor = 'rgba(0,0,0,0.3)',
  checkColor = '#FFFFFF',
  checkSize,
  strokeWidth = 2.4,
  style,
}) {
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; v.setValue(on ? 1 : 0); return; }
    let animate = true;
    try { animate = motionEnabled(); } catch {}
    if (!animate) { v.setValue(on ? 1 : 0); return; }
    v.stopAnimation();
    if (on) {
      Animated.spring(v, { toValue: 1, ...Springs.pop, useNativeDriver: ND }).start();
    } else {
      Animated.timing(v, { toValue: 0, duration: 120, easing: Easing.in(Easing.quad), useNativeDriver: ND }).start();
    }
  }, [on, v]);

  const r = size / 2;
  const cs = checkSize || Math.round(size * 0.64);
  const fillScale = v.interpolate({ inputRange: [0, 1, 2], outputRange: [0.5, 1, 1.5] });
  const fillOpacity = v.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' });
  const checkOpacity = v.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0, 1], extrapolate: 'clamp' });
  const checkScale = v.interpolate({ inputRange: [0, 0.55, 1, 2], outputRange: [0.4, 0.4, 1, 1.4] });

  return (
    <View
      style={[{
        width: size, height: size, borderRadius: r,
        borderWidth, borderColor: offColor,
        alignItems: 'center', justifyContent: 'center',
      }, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute', top: -borderWidth, left: -borderWidth,
          width: size, height: size, borderRadius: r,
          backgroundColor: onColor,
          alignItems: 'center', justifyContent: 'center',
          opacity: fillOpacity,
          transform: [{ scale: fillScale }],
        }}
      >
        <Animated.View style={{ opacity: checkOpacity, transform: [{ scale: checkScale }] }}>
          <Svg width={cs} height={cs} viewBox="0 0 24 24">
            <Path d="M5 12.5l4.2 4.2L19 7" stroke={checkColor} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export default React.memo(SelectionCheck);
