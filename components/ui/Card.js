// Card — superfície agrupada. Claro: branco + hairline (sombra opcional bem
// sutil). Escuro: nível de cinza (#111 / #1c1c1e), sem sombra.
//   <Card>…</Card>
//   <Card onPress={…} padding={16} elevated>…</Card>    // tocável (PressableScale)
//   <Card padding={0}> <ListRow …/> <ListRow …/> </Card> // grupo "inset grouped"
// Props: padding (default 16), elevated (sombra sutil no claro / #1c1c1e no
// escuro), bordered (default true no claro), radius, style, onPress, onLongPress.
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import PressableScale from '../PressableScale';
import { Radius } from '../../constants/theme';
import useSurface from './useSurface';

export default function Card({
  children, onPress, onLongPress, padding = 16, elevated = false, bordered,
  radius = Radius.card, style, accessibilityLabel, testID,
}) {
  const s = useSurface();
  const showBorder = bordered != null ? bordered : !s.isDark;
  const base = [{
    backgroundColor: elevated ? s.surfaceRaised : s.surface,
    borderRadius: radius,
    padding,
    overflow: 'hidden',
    ...(showBorder ? { borderWidth: StyleSheet.hairlineWidth, borderColor: s.border } : null),
    ...(elevated && !s.isDark ? s.shadow : null),
    ...(elevated && !s.isDark && Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)' } : null),
  }, style];
  if (onPress || onLongPress) {
    return (
      <PressableScale onPress={onPress} onLongPress={onLongPress} scaleTo={0.985} style={base}
        accessibilityRole="button" accessibilityLabel={accessibilityLabel} testID={testID}>
        {children}
      </PressableScale>
    );
  }
  return <View style={base} testID={testID}>{children}</View>;
}
