// TopBar — header padrão de tela (chapado + hairline, como UINavigationBar /
// M3 top app bar). Safe-area de topo incluída (safeTop=false p/ desligar).
//   <TopBar title="Arquivos" onBack={() => router.back()} />
//   <TopBar title="Ajustes" right={<IconButton icon={IconSearch} …/>} />
//   <TopBar largeTitle="Ligações" right={…} />       // título grande à esquerda
//   <TopBar title="Grupo" subtitle="12 membros" align="left" onBack={…} />
// Props: title, subtitle, largeTitle, onBack, backIcon ('chevron'|'arrow'|'close'),
//   backLabel (a11y), left/right (nós), align ('center' iOS | 'left'),
//   hairline (default true), transparent, safeTop (default true), style.
// Mantém 44px de alvo no botão voltar. Web desktop: conteúdo limitado a
// `maxWidth` quando passado (ex. Layout.contentMaxWidth).
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconArrowLeft, IconChevronLeft, IconX } from '../Icons';
import { Layout, Type } from '../../constants/theme';
import { IconButton } from './Button';
import useSurface from './useSurface';
import { useLanguageOptional } from '../../context/LanguageContext';

export default function TopBar({
  title, subtitle, largeTitle, onBack, backIcon, backLabel, left, right,
  align, hairline = true, transparent = false, safeTop = true, maxWidth, style, testID,
}) {
  const s = useSurface();
  const insets = useSafeAreaInsets();
  const _lang = useLanguageOptional();
  const _backA11y = backLabel || _lang?.t?.('common.back') || 'Voltar';
  const centered = (align || (Platform.OS === 'ios' ? 'center' : 'left')) === 'center' && !largeTitle;
  const BackIcon = backIcon === 'close' ? IconX : backIcon === 'arrow' ? IconArrowLeft
    : backIcon === 'chevron' ? IconChevronLeft : (Platform.OS === 'ios' ? IconChevronLeft : IconArrowLeft);
  const leftNode = left || (onBack ? (
    <IconButton icon={BackIcon} iconSize={backIcon === 'close' ? 22 : 24} onPress={onBack}
      accessibilityLabel={_backA11y} color={s.text} haptic={false} />
  ) : null);

  return (
    <View testID={testID} style={[{
      paddingTop: safeTop ? insets.top : 0,
      backgroundColor: transparent ? 'transparent' : s.bg,
      ...(hairline ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator } : null),
    }, style]}>
      <View style={[styles.bar, maxWidth ? { maxWidth, width: '100%', alignSelf: 'center' } : null]}>
        {leftNode ? <View style={styles.side}>{leftNode}</View> : (centered ? <View style={styles.sideSpacer} /> : null)}
        <View style={[styles.titleBox, centered ? styles.titleCenter : { paddingLeft: leftNode ? 4 : 8 }]}>
          {largeTitle ? (
            <Text accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={1.3} style={[Type.title1, { color: s.text }]}>
              {largeTitle}
            </Text>
          ) : title ? (
            <Text accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={1.3}
              style={[Type.headline, { fontSize: 17, color: s.text, textAlign: centered ? 'center' : 'left' }]}>
              {title}
            </Text>
          ) : null}
          {subtitle && !largeTitle ? (
            <Text numberOfLines={1} maxFontSizeMultiplier={1.3}
              style={[Type.caption, { color: s.textSecondary, textAlign: centered ? 'center' : 'left', marginTop: 1 }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={[styles.side, styles.sideRight]}>{right}</View> : (centered ? <View style={styles.sideSpacer} /> : null)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center',
    minHeight: Layout.topBarHeight, paddingHorizontal: 6,
  },
  side: { minWidth: Layout.hitTarget, flexDirection: 'row', alignItems: 'center' },
  sideRight: { justifyContent: 'flex-end', gap: 2, paddingRight: 2 },
  sideSpacer: { minWidth: Layout.hitTarget },
  titleBox: { flex: 1, minWidth: 0, justifyContent: 'center' },
  titleCenter: { alignItems: 'center', paddingHorizontal: 4 },
});
