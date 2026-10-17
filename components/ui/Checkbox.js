// Checkbox + Chip — micro-interações P&B do design system (2026-10-16 motion).
//
//   <Checkbox checked={on} onChange={setOn} label="Lembrar" />
//   <Chip label="Não lidas" selected={f === 'unread'} onPress={() => setF('unread')} />
//
// Checkbox: quadrado 22 (raio 6); marcado = tinta (ink) com check SVG que entra
// com mola "pop" (Springs.pop: 0.6→1) + tique de seleção (feedback.selection,
// respeita "Vibração ao tocar"). Reduzir Movimento = troca seca. `round` = círculo
// (seleção múltipla estilo iOS). Alvo de toque ≥ 44 via hitSlop.
// Chip: pílula 32 (PressableScale scale PressScale.chip); selecionado = tinta
// invertida; tique de seleção só ao mudar.
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import PressableScale from '../PressableScale';
import { Springs, PressScale, motionEnabled, feedback } from '../../constants/motion';
import { Type, Radius } from '../../constants/theme';
import useSurface from './useSurface';

const ND = Platform.OS !== 'web';

export function Checkbox({ checked = false, onChange, label, disabled = false, round = false, size = 22, style, testID, accessibilityLabel }) {
  const s = useSurface();
  const v = useRef(new Animated.Value(checked ? 1 : 0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; v.setValue(checked ? 1 : 0); return; }
    if (!motionEnabled()) { v.setValue(checked ? 1 : 0); return; }
    if (checked) { v.setValue(0.6); Animated.spring(v, { toValue: 1, ...Springs.pop, useNativeDriver: ND }).start(); }
    else Animated.spring(v, { toValue: 0, ...Springs.snappy, overshootClamping: true, useNativeDriver: ND }).start();
  }, [checked, v]);
  const toggle = () => {
    if (disabled) return;
    feedback.selection();
    onChange?.(!checked);
  };
  const box = (
    <View style={{
      width: size, height: size, borderRadius: round ? size / 2 : 6,
      borderWidth: checked ? 0 : 1.5, borderColor: s.textTertiary || s.separator,
      backgroundColor: checked ? s.ink : 'transparent',
      alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1,
    }}>
      <Animated.View style={{ opacity: v, transform: [{ scale: v }] }}>
        <Svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24">
          <Path d="M5 12.5l4.2 4.2L19 7" stroke={s.onInk} strokeWidth={2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Animated.View>
    </View>
  );
  return (
    <Pressable
      onPress={toggle}
      disabled={disabled}
      hitSlop={label ? 4 : 11}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !!checked, disabled: !!disabled }}
      aria-checked={!!checked}
      accessibilityLabel={accessibilityLabel || (typeof label === 'string' ? label : undefined)}
      testID={testID}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: label ? 44 : undefined }, style]}
    >
      {box}
      {label != null ? (typeof label === 'string'
        ? <Text style={[Type.body, { color: s.text, flexShrink: 1 }]}>{label}</Text>
        : label) : null}
    </Pressable>
  );
}

export function Chip({ label, selected = false, onPress, icon, disabled = false, style, testID }) {
  const s = useSurface();
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      scaleTo={PressScale.chip}
      haptic={selected ? false : 'select'}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      testID={testID}
      style={[{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        height: 32, paddingHorizontal: 14, borderRadius: Radius.pill,
        backgroundColor: selected ? s.ink : s.fill,
        opacity: disabled ? 0.45 : 1,
      }, style]}
    >
      {icon || null}
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontSize: 14, fontWeight: selected ? '600' : '500', color: selected ? s.onInk : s.text }}>
        {label}
      </Text>
    </PressableScale>
  );
}

export default Checkbox;
