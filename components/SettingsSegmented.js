/**
 * SettingsSegmented — iOS-style segmented control used by Settings sub-screens
 * (tema, download automático de mídia). Trilho surfaceVariant + "pílula" ativa
 * em surface com borda hairline. Pure JS (OTA-safe), theme-aware via `colors`.
 *
 * options: [{ value, label }]; value: current; onChange(value).
 *
 * [2026-10-16 motion] A pílula agora DESLIZA até o segmento novo (mola
 * Springs.segment, a mesma do components/ui/SegmentedControl) + tique de
 * seleção ao trocar. Mesmo visual de antes. Reduzir Movimento = troca seca.
 * Kill switch OTA: globalThis.__chatyy_motion_segmented = false → pílula
 * estática por segmento (comportamento antigo).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Platform } from 'react-native';
import { Springs, motionEnabled, feedback } from '../constants/motion';

export default function SettingsSegmented({ options, value, onChange, colors, isDark, compact }) {
  const track = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(60,60,67,0.12)';
  const pill = isDark ? 'rgba(255,255,255,0.18)' : (colors?.surface || '#fff');
  const border = colors?.border || 'rgba(0,0,0,0.08)';
  const n = Math.max(1, (options || []).length);
  const idx = Math.max(0, (options || []).findIndex((o) => o.value === value));
  const [w, setW] = useState(0);
  const segW = w > 0 ? (w - 4) / n : 0;
  const sliding = segW > 0 && (() => { try { return globalThis.__chatyy_motion_segmented !== false; } catch { return true; } })();
  const anim = useRef(new Animated.Value(idx)).current;
  useEffect(() => {
    if (!motionEnabled()) { anim.setValue(idx); return; }
    Animated.spring(anim, { toValue: idx, ...Springs.segment, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [idx, anim]);
  return (
    <View
      onLayout={(e) => { const nw = e.nativeEvent.layout.width; if (Math.abs(nw - w) > 0.5) setW(nw); }}
      style={{ flexDirection: 'row', padding: 2, borderRadius: 10, backgroundColor: track }}
    >
      {sliding ? (
        <Animated.View pointerEvents="none" style={{
          position: 'absolute', top: 2, bottom: 2, left: 2, width: segW, borderRadius: 8,
          backgroundColor: pill, borderWidth: StyleSheet.hairlineWidth, borderColor: border,
          transform: [{ translateX: anim.interpolate({ inputRange: [0, Math.max(1, n - 1)], outputRange: [0, segW * Math.max(1, n - 1)] }) }],
        }} />
      ) : null}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => { if (!active) { feedback.selection(); onChange?.(o.value); } }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
            style={{
              flex: 1, alignItems: 'center', justifyContent: 'center',
              paddingVertical: compact ? 6 : 8, borderRadius: 8,
              backgroundColor: active && !sliding ? pill : 'transparent',
              borderWidth: active && !sliding ? StyleSheet.hairlineWidth : 0,
              borderColor: border,
            }}
          >
            <Text numberOfLines={1} style={{
              fontSize: 13, letterSpacing: -0.1,
              fontWeight: active ? '700' : '500',
              color: active ? (colors?.text || '#111') : (colors?.textSecondary || '#64748b'),
            }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
