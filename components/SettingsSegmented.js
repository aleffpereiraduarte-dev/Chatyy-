/**
 * SettingsSegmented — iOS-style segmented control used by Settings sub-screens
 * (tema, download automático de mídia). Trilho surfaceVariant + "pílula" ativa
 * em surface com borda hairline. Pure JS (OTA-safe), theme-aware via `colors`.
 *
 * options: [{ value, label }]; value: current; onChange(value).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

export default function SettingsSegmented({ options, value, onChange, colors, isDark, compact }) {
  const track = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(60,60,67,0.12)';
  const pill = isDark ? 'rgba(255,255,255,0.18)' : (colors?.surface || '#fff');
  return (
    <View style={{
      flexDirection: 'row', padding: 2, borderRadius: 10,
      backgroundColor: track,
    }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => { if (!active) onChange?.(o.value); }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
            style={{
              flex: 1, alignItems: 'center', justifyContent: 'center',
              paddingVertical: compact ? 6 : 8, borderRadius: 8,
              backgroundColor: active ? pill : 'transparent',
              borderWidth: active ? StyleSheet.hairlineWidth : 0,
              borderColor: colors?.border || 'rgba(0,0,0,0.08)',
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
