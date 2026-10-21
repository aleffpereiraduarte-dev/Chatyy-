// Button — botão padrão P&B. Base: PressableScale (mola + haptic leve).
//   <Button title="Continuar" onPress={…} />                       // primário (tinta)
//   <Button variant="secondary" title="Cancelar" onPress={…} />    // cinza preenchido
//   <Button variant="ghost" title="Pular" onPress={…} />           // só texto
//   <Button variant="destructive" title="Apagar" onPress={…} />    // vermelho
//   <Button size="sm" icon={IconPlus} title="Novo" />  (sm 36 c/ hitSlop | md 44 | lg 52)
// Props: title | children, variant, size, icon (componente SVG {size,color}),
//   iconRight, loading, disabled, fullWidth, style, textStyle, accessibilityLabel.
//
// IconButton — botão só-ícone circular, alvo de 44px (header, toolbars).
//   <IconButton icon={IconSearch} onPress={…} accessibilityLabel="Buscar" />
//   variant: 'plain' (default, sem fundo) | 'filled' (fill cinza) | 'ink'
import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import PressableScale from '../PressableScale';
import { Layout, Radius, Type, THEME_V2, bubbleOwnStyle } from '../../constants/theme';
import useSurface from './useSurface';

const HEIGHTS = { sm: 36, md: 44, lg: 52 };

function palette(s, variant) {
  switch (variant) {
    case 'secondary': return { bg: s.fill, fg: s.text, border: 'transparent' };
    case 'outline': return { bg: 'transparent', fg: s.text, border: s.separator };
    case 'ghost': return { bg: 'transparent', fg: s.text, border: 'transparent' };
    case 'destructive': return { bg: s.danger, fg: '#FFFFFF', border: 'transparent' };
    case 'destructiveGhost': return { bg: 'transparent', fg: s.danger, border: 'transparent' };
    default: return { bg: s.ink, fg: s.onInk, border: 'transparent' };
  }
}

export default function Button({
  title,
  children,
  onPress,
  onLongPress,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  haptic = 'light',
  style,
  textStyle,
  accessibilityLabel,
  testID,
}) {
  const s = useSurface();
  const p = palette(s, variant);
  const h = HEIGHTS[size] || HEIGHTS.md;
  const isDisabled = disabled || loading;
  const label = title != null ? title : children;
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <PressableScale
      onPress={isDisabled ? undefined : onPress}
      onLongPress={isDisabled ? undefined : onLongPress}
      disabled={isDisabled}
      haptic={haptic}
      scaleTo={0.97}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || (typeof label === 'string' ? label : undefined)}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      hitSlop={h < Layout.hitTarget ? { top: (Layout.hitTarget - h) / 2, bottom: (Layout.hitTarget - h) / 2, left: 4, right: 4 } : undefined}
      testID={testID}
      style={[
        styles.base,
        {
          height: h,
          paddingHorizontal: size === 'sm' ? 14 : variant === 'ghost' ? 12 : 20,
          borderRadius: size === 'lg' ? Radius.card : Radius.control,
          backgroundColor: p.bg,
          borderColor: p.border,
          borderWidth: p.border === 'transparent' ? 0 : StyleSheet.hairlineWidth * 2,
          opacity: disabled && !loading ? 0.4 : 1,
          alignSelf: fullWidth ? 'stretch' : 'auto',
        },
        // [2026-10-20 grafite] primário no claro = grafite com gradiente + reflexo de 1 px (mockup)
        THEME_V2 && variant === 'primary' && !s.isDark ? bubbleOwnStyle(false) : null,
        Platform.OS === 'web' ? { cursor: isDisabled ? 'default' : 'pointer', userSelect: 'none' } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={p.fg} />
      ) : (
        <View style={styles.inner}>
          {Icon ? <Icon size={iconSize} color={p.fg} /> : null}
          {label != null && label !== '' ? (
            <Text numberOfLines={1} maxFontSizeMultiplier={1.4}
              style={[size === 'sm' ? Type.buttonSm : Type.button, { color: p.fg }, textStyle]}>
              {label}
            </Text>
          ) : null}
          {IconRight ? <IconRight size={iconSize} color={p.fg} /> : null}
        </View>
      )}
    </PressableScale>
  );
}

export function IconButton({
  icon: Icon,
  onPress,
  onLongPress,
  variant = 'plain',
  size = 40,
  iconSize = 22,
  color,
  disabled = false,
  accessibilityLabel,
  haptic = 'light',
  style,
  testID,
  children,
}) {
  const s = useSurface();
  const bg = variant === 'filled' ? s.fill : variant === 'ink' ? s.ink : 'transparent';
  const fg = color || (variant === 'ink' ? s.onInk : s.icon);
  const slop = Math.max(0, (Layout.hitTarget - size) / 2);
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      haptic={haptic}
      scaleTo={0.92}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={slop ? { top: slop, bottom: slop, left: slop, right: slop } : undefined}
      testID={testID}
      style={[{
        width: size, height: size, borderRadius: size / 2,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: bg, opacity: disabled ? 0.4 : 1,
      }, Platform.OS === 'web' ? { cursor: disabled ? 'default' : 'pointer' } : null, style]}
    >
      {Icon ? <Icon size={iconSize} color={fg} /> : children}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
