// ActionList — linhas de ação do design system de overlays (2026-10-12).
//
// variant 'sheet' (padrão, toque): linha 52px, ícone SVG 22 à esquerda, rótulo
//   16, destrutivo em vermelho (ícone + texto), separador hairline recuado,
//   feedback nativo de célula (PressableRow: realce iOS / ripple Android).
// variant 'menu' (desktop/clique direito): linha 36px, ícone 18, rótulo 14,
//   hover suave no web.
//
// items: [{ key, label, icon: IconComponent, onPress, destructive, disabled,
//           subtitle, right, color, keepOpen } | { separator: true }]
// onDone: chamado ANTES de item.onPress (fecha o sheet/menu) — a ação roda
//   no próximo frame p/ não brigar com a animação de saída.
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import PressableRow from '../PressableRow';
import { Overlay } from '../../constants/theme';
import { useOverlayColors } from './Sheet';

function Row({ item, variant, oc, onDone, isLast, showSeparator }) {
  const [hover, setHover] = useState(false);
  const isMenu = variant === 'menu';
  const danger = !!item.destructive;
  const tint = item.color || (danger ? oc.danger : null);
  const Icon = item.icon;
  const iconSize = isMenu ? Overlay.menuIconSize : Overlay.iconSize;
  const disabled = !!item.disabled;

  const run = () => {
    if (disabled) return;
    if (!item.keepOpen && typeof onDone === 'function') {
      try { onDone(item); } catch {}
      if (typeof item.onPress === 'function') setTimeout(() => { try { item.onPress(); } catch {} }, 0);
      return;
    }
    try { item.onPress && item.onPress(); } catch {}
  };

  const content = (
    <>
      {Icon ? (
        <View style={{ width: iconSize, alignItems: 'center' }}>
          {React.isValidElement(Icon) ? Icon : <Icon size={iconSize} color={tint || oc.icon} />}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontSize: isMenu ? Overlay.menuLabelSize : Overlay.labelSize,
            fontWeight: Overlay.labelWeight,
            color: tint || oc.text,
            letterSpacing: isMenu ? 0 : -0.2,
          }}
        >
          {item.label}
        </Text>
        {item.subtitle ? (
          <Text numberOfLines={1} style={{ fontSize: 13, color: oc.textSecondary, marginTop: 1 }}>{item.subtitle}</Text>
        ) : null}
      </View>
      {item.right || null}
    </>
  );

  const rowStyle = {
    flexDirection: 'row', alignItems: 'center',
    minHeight: isMenu ? Overlay.menuRowHeight : Overlay.rowHeight,
    paddingHorizontal: isMenu ? 12 : Overlay.padX,
    gap: isMenu ? 10 : Overlay.rowGap,
    opacity: disabled ? 0.4 : 1,
  };

  const sep = showSeparator && !isLast ? (
    <View style={{
      height: StyleSheet.hairlineWidth, backgroundColor: oc.separator,
      marginLeft: Icon ? (Overlay.padX + iconSize + Overlay.rowGap) : Overlay.padX,
    }} />
  ) : null;

  if (isMenu && Platform.OS === 'web') {
    return (
      <Pressable
        onPress={run}
        disabled={disabled}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        accessibilityRole="menuitem"
        accessibilityLabel={item.label}
        style={[rowStyle, {
          marginHorizontal: 4, borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
          backgroundColor: hover && !disabled ? (danger ? oc.dangerTint : oc.pressed) : 'transparent',
        }]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <>
      <PressableRow
        onPress={run}
        disabled={disabled}
        highlightColor={oc.pressed}
        style={rowStyle}
        accessibilityRole="button"
        accessibilityLabel={item.label}
        accessibilityState={disabled ? { disabled: true } : undefined}
      >
        {content}
      </PressableRow>
      {sep}
    </>
  );
}

export default function ActionList({
  items,
  onDone,
  variant = 'sheet',
  separators = false,
  style,
}) {
  const oc = useOverlayColors();
  const list = (items || []).filter(Boolean);
  return (
    <View style={[{ paddingVertical: variant === 'menu' ? 4 : 0 }, style]}>
      {list.map((it, i) => {
        if (it.separator || it._separator) {
          return variant === 'menu'
            ? <View key={`sep-${i}`} style={{ height: StyleSheet.hairlineWidth, backgroundColor: oc.separator, marginVertical: 4, marginHorizontal: 12 }} />
            : <View key={`sep-${i}`} style={{ height: 8 }} />;
        }
        const nextIsSep = !list[i + 1] || list[i + 1].separator || list[i + 1]._separator;
        return (
          <Row
            key={it.key || `it-${i}`}
            item={it}
            variant={variant}
            oc={oc}
            onDone={onDone}
            isLast={nextIsSep}
            showSeparator={separators}
          />
        );
      })}
    </View>
  );
}

// Sheet de ações pronto (Sheet + ActionList + botão Cancelar opcional).
export { default as Sheet } from './Sheet';
