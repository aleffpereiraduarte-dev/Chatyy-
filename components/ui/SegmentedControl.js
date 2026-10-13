// SegmentedControl — controle segmentado com "pílula" deslizante (iOS 17).
//   <SegmentedControl
//     options={[{ value: 'all', label: 'Tudo' }, { value: 'unread', label: 'Não lidas' }]}
//     value={filter} onChange={setFilter} />
// Props: options [{value,label}], value, onChange(value), size 'md'(36)|'sm'(30),
//   style. Trilho = fill cinza; pílula = branco (claro) / #3a3a3c (escuro).
// Mesma API do antigo components/SettingsSegmented (que pode delegar a este).
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { haptic, Radius } from '../../constants/theme';
import { isReduceMotionEnabled } from '../reducedMotion';
import useSurface from './useSurface';

export default function SegmentedControl({ options = [], value, onChange, size = 'md', style, testID }) {
  const s = useSurface();
  const [w, setW] = useState(0);
  const n = Math.max(1, options.length);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const anim = useRef(new Animated.Value(idx)).current;
  const pad = 2;
  const segW = w > 0 ? (w - pad * 2) / n : 0;

  useEffect(() => {
    if (isReduceMotionEnabled()) { anim.setValue(idx); return; }
    Animated.spring(anim, { toValue: idx, useNativeDriver: true, tension: 260, friction: 26 }).start();
  }, [idx, anim]);

  const h = size === 'sm' ? 30 : 36;
  const thumbBg = s.isDark ? '#3A3A3C' : '#FFFFFF';
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      onLayout={(e) => { const nw = e.nativeEvent.layout.width; if (Math.abs(nw - w) > 0.5) setW(nw); }}
      style={[{ flexDirection: 'row', height: h, padding: pad, borderRadius: Radius.control, backgroundColor: s.fill }, style]}
    >
      {segW > 0 ? (
        <Animated.View pointerEvents="none" style={{
          position: 'absolute', top: pad, bottom: pad, left: pad, width: segW,
          borderRadius: Radius.control - 2, backgroundColor: thumbBg,
          ...(s.isDark ? null : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 1 }),
          ...(Platform.OS === 'web' && !s.isDark ? { boxShadow: '0 1px 3px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.04)' } : null),
          transform: [{ translateX: anim.interpolate({ inputRange: [0, Math.max(1, n - 1)], outputRange: [0, segW * Math.max(1, n - 1)] }) }],
        }} />
      ) : null}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => { if (!active) { try { haptic.select(); } catch {} onChange?.(o.value); } }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={typeof o.label === 'string' ? o.label : undefined}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[styles.seg, Platform.OS === 'web' ? { cursor: active ? 'default' : 'pointer' } : null]}
          >
            <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{
              fontSize: size === 'sm' ? 13 : 14, letterSpacing: -0.1,
              fontWeight: active ? '600' : '500',
              color: active ? s.text : s.textSecondary,
            }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  seg: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
});
