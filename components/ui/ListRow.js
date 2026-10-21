// ListRow — célula de lista padrão (configurações, menus, contatos, detalhes).
// Toque nativo via PressableRow (realce cinza no iOS, ripple no Android,
// PressableScale sutil no web). Altura mín. 52 (1 linha) / 64 (c/ subtítulo).
//
//   <ListRow icon={IconBell} title="Notificações" chevron onPress={…} />
//   <ListRow leading={<AvatarCircle …/>} title="Ana" subtitle="online" />
//   <ListRow title="Tema" value="Escuro" chevron onPress={…} />
//   <ListRow title="Sair" destructive onPress={…} />
//   <ListRow title="Som" accessory={<NativeSwitch …/>} />
//
// Props:
//   icon        componente SVG ({size,color}) — desenhado em 22px, cor do tema
//   iconTile    true = ícone dentro de quadradinho cinza 30px (estilo Ajustes)
//   leading     nó livre à esquerda (avatar etc.) — substitui icon
//   title, subtitle (2 linhas máx), value (texto cinza à direita)
//   accessory   nó livre à direita (switch, badge, botão)
//   chevron     mostra ">" no final
//   destructive título vermelho
//   separator   true = hairline embaixo (alinhada ao texto); default false
//   onPress / onLongPress / disabled / selected / style / testID
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import PressableRow from '../PressableRow';
import { IconChevronRight } from '../Icons';
import { Layout, Radius, Type } from '../../constants/theme';
import { THEME_V2, Grafite } from '../../constants/theme';
// [2026-10-20 grafite] ícone em ladrilho grafite (raio 10, gradiente + reflexo de 1 px).
const _tileC = {};
function _grafiteTile(dark) {
  const k = dark ? 'd' : 'l';
  if (_tileC[k]) return _tileC[k];
  const g = dark ? Grafite.dark : Grafite.light;
  const grad = `linear-gradient(160deg, ${g.tile[0]} 0%, ${g.tile[1]} 100%)`;
  const sh = 'inset 0px 1px 0px rgba(255,255,255,0.18), 0px 2px 6px rgba(0,0,0,0.12)';
  _tileC[k] = Platform.OS === 'web'
    ? { backgroundColor: g.tile[1], backgroundImage: grad, boxShadow: sh, borderRadius: Grafite.radius.tile }
    : { backgroundColor: g.tile[1], experimental_backgroundImage: grad, boxShadow: sh, borderRadius: Grafite.radius.tile };
  return _tileC[k];
}
import useSurface from './useSurface';

export default function ListRow({
  icon: Icon, iconTile = false, iconColor, leading, title, subtitle, value, accessory,
  chevron = false, destructive = false, separator = false, selected = false,
  onPress, onLongPress, disabled = false, numberOfLines = 1, style, titleStyle,
  accessibilityLabel, accessibilityHint, testID,
}) {
  const s = useSurface();
  const titleColor = destructive ? s.danger : s.text;
  const icColor = iconColor || (destructive ? s.danger : s.icon);
  const lead = leading || (Icon ? (
    iconTile ? (
      <View style={[styles.tile, { backgroundColor: s.fill }, THEME_V2 && !destructive && !iconColor ? _grafiteTile(s.isDark) : null]}>
        <Icon size={18} color={THEME_V2 && !destructive && !iconColor ? '#FFFFFF' : icColor} />
      </View>
    ) : (
      <View style={styles.iconBox}><Icon size={Layout.iconSize} color={icColor} /></View>
    )
  ) : null);
  const textInset = Layout.gutter + (lead ? (leading ? 52 : iconTile ? 42 : 38) : 0);

  const body = (
    <View style={[styles.row, { minHeight: subtitle ? Layout.rowMinHeightTall : Layout.rowMinHeight, opacity: disabled ? 0.45 : 1 },
      selected ? { backgroundColor: s.pressed } : null, style]}>
      {lead ? <View style={styles.lead}>{lead}</View> : null}
      <View style={styles.texts}>
        {title != null ? (
          <Text numberOfLines={numberOfLines} maxFontSizeMultiplier={1.5} style={[Type.body, { color: titleColor }, titleStyle]}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text numberOfLines={2} maxFontSizeMultiplier={1.5} style={[Type.footnote, { color: s.textSecondary, marginTop: 2 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value != null && value !== '' ? (
        <Text numberOfLines={1} maxFontSizeMultiplier={1.4} style={[Type.callout, styles.value, { color: s.textSecondary }]}>
          {value}
        </Text>
      ) : null}
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
      {chevron ? <IconChevronRight size={18} color={s.textTertiary} /> : null}
      {separator ? (
        <View pointerEvents="none" style={[styles.sep, { left: textInset, backgroundColor: s.separator }]} />
      ) : null}
    </View>
  );

  if (!onPress && !onLongPress) return <View testID={testID}>{body}</View>;
  return (
    <PressableRow
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      disabled={disabled}
      highlightColor={s.pressed}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || (typeof title === 'string' ? (value ? `${title}, ${value}` : title) : undefined)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      style={Platform.OS === 'web' ? { cursor: disabled ? 'default' : 'pointer' } : undefined}
      testID={testID}
    >
      {body}
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Layout.gutter, paddingVertical: 10, gap: 12,
  },
  lead: { alignItems: 'center', justifyContent: 'center' },
  iconBox: { width: 26, alignItems: 'center', justifyContent: 'center' },
  tile: { width: 30, height: 30, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, minWidth: 0, justifyContent: 'center' },
  value: { maxWidth: '45%', textAlign: 'right' },
  accessory: { alignItems: 'center', justifyContent: 'center' },
  sep: { position: 'absolute', right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
