// SectionHeader — título de seção.
//   <SectionHeader title="Fixadas" />                        // 'list': headline 16/600
//   <SectionHeader title="Privacidade" variant="grouped" />  // CAPS cinza (iOS grouped)
//   <SectionHeader title="Recentes" actionLabel="Ver tudo" onAction={…} />
//   <SectionHeader title="Grande" variant="large" />          // title2 (topo de página)
// Props: title, subtitle, variant, actionLabel, onAction, right (nó livre), inset, style.
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Layout, Type } from '../../constants/theme';
import useSurface from './useSurface';

export default function SectionHeader({
  title, subtitle, variant = 'list', actionLabel, onAction, right, inset = Layout.gutter, style,
}) {
  const s = useSurface();
  const grouped = variant === 'grouped';
  const titleStyle = grouped ? Type.sectionCaps : variant === 'large' ? Type.title2 : Type.headline;
  return (
    <View style={[{
      flexDirection: 'row', alignItems: grouped ? 'flex-end' : 'center',
      paddingHorizontal: inset,
      paddingTop: grouped ? 20 : variant === 'large' ? 16 : 16,
      paddingBottom: grouped ? 6 : 8,
      minHeight: grouped ? 0 : 40,
    }, style]}>
      <View style={{ flex: 1 }}>
        {title ? (
          <Text accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={1.4}
            style={[titleStyle, { color: grouped ? s.textSecondary : s.text }]}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text numberOfLines={2} maxFontSizeMultiplier={1.4} style={[Type.footnote, { color: s.textSecondary, marginTop: 2 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right || null}
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={12} accessibilityRole="button"
          style={({ pressed }) => [{ minHeight: 32, justifyContent: 'center', paddingLeft: 12, opacity: pressed ? 0.5 : 1 },
            Platform.OS === 'web' ? { cursor: 'pointer' } : null]}>
          <Text style={[Type.subhead, { color: s.text, fontWeight: '600' }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
