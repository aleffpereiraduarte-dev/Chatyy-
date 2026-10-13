// Badge — contador / ponto / rótulo. P&B por padrão (tinta invertida no
// escuro); cor só p/ estado.
//   <Badge count={3} />                 // pílula numérica (99+)
//   <Badge dot />                       // ponto 8px (não lido sem número)
//   <Badge label="Novo" tone="neutral"/>// rótulo pequeno
//   tone: 'ink' (default) | 'neutral' (cinza) | 'danger' | 'success' | 'muted'
//   ring: cor do anel (p/ cortar ícone/avatar por baixo), ex. a cor da barra.
import React from 'react';
import { Text, View } from 'react-native';
import { Radius } from '../../constants/theme';
import useSurface from './useSurface';

function tones(s, tone) {
  switch (tone) {
    case 'neutral': return { bg: s.fill, fg: s.text };
    case 'muted': return { bg: s.fill, fg: s.textSecondary };
    case 'danger': return { bg: s.danger, fg: '#FFFFFF' };
    case 'success': return { bg: s.success, fg: '#FFFFFF' };
    default: return { bg: s.ink, fg: s.onInk };
  }
}

export default function Badge({ count, dot = false, label, tone = 'ink', ring, max = 99, style, textStyle, accessibilityLabel }) {
  const s = useSurface();
  const t = tones(s, tone);
  const ringStyle = ring ? { borderWidth: 2, borderColor: ring } : null;
  if (dot) {
    return <View accessibilityLabel={accessibilityLabel} style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.bg }, ringStyle, style]} />;
  }
  let text = label;
  if (text == null) {
    const n = Number(count) || 0;
    if (n <= 0) return null;
    text = n > max ? `${max}+` : String(n);
  }
  const isLabel = label != null;
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[{
        minWidth: 20, height: 20, paddingHorizontal: isLabel ? 8 : 6,
        borderRadius: Radius.pill, backgroundColor: t.bg,
        alignItems: 'center', justifyContent: 'center',
      }, ringStyle, style]}
    >
      <Text numberOfLines={1} maxFontSizeMultiplier={1.2}
        style={[{ fontSize: isLabel ? 11 : 12, lineHeight: 14, fontWeight: isLabel ? '600' : '700', color: t.fg, fontVariant: ['tabular-nums'] }, textStyle]}>
        {text}
      </Text>
    </View>
  );
}
