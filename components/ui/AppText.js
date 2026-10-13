// AppText — texto com a escala tipográfica nomeada (Type) + tom semântico.
//   <AppText variant="headline">Título</AppText>
//   <AppText variant="footnote" tone="secondary">metadado</AppText>
// variant: largeTitle | title1 | title2 | title3 | headline | body | callout |
//          subhead | footnote | caption | caption2 | sectionCaps
// tone: primary (default) | secondary | tertiary | danger | success | inverse
// `weight` sobrescreve o peso da variante ('400'…'800'). Demais props → <Text>.
import React from 'react';
import { Text } from 'react-native';
import { Type } from '../../constants/theme';
import useSurface from './useSurface';

export function toneColor(s, tone) {
  switch (tone) {
    case 'secondary': return s.textSecondary;
    case 'tertiary': return s.textTertiary;
    case 'danger': return s.danger;
    case 'success': return s.success;
    case 'inverse': return s.onInk;
    default: return s.text;
  }
}

export default function AppText({ variant = 'body', tone = 'primary', weight, align, style, children, ...props }) {
  const s = useSurface();
  return (
    <Text
      maxFontSizeMultiplier={1.6}
      {...props}
      style={[
        Type[variant] || Type.body,
        { color: toneColor(s, tone) },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}
