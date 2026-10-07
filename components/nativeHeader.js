// [2026-10-07 app-feel-nav] Header NATIVO (react-native-screens) p/ telas
// pushadas — UINavigationBar no iOS (título anima JUNTO com o push, back
// chevron do sistema com menu de long-press, swipe-back sincronizado) e
// Toolbar Material no Android. Antes cada tela desenhava um <View> com
// TouchableOpacity + texto (header de site: sobe junto com o conteúdo na
// transição, altura fixa, sombra web).
//
// Web continua com o header custom de cada tela (USE_NATIVE_HEADER=false):
// o native-stack no web renderiza um header JS genérico que não combina.
//
// Uso:
//   import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader';
//   {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({ colors, title, headerRight: () => ... })} />}
//   <View style={{ paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }}>
import React from 'react';
import { Platform, Pressable } from 'react-native';
import { HeaderHeightContext } from '@react-navigation/elements'; // [2026-10-07 native-ui-build] (dep do expo-router, cópia única)
import { haptic } from '../constants/theme';
import { IconChevronLeft, IconArrowLeft } from './Icons';

export const USE_NATIVE_HEADER = Platform.OS !== 'web';

// [2026-10-07 native-ui-build] Header de VIDRO no iOS: UINavigationBar
// transparente + UIBlurEffect do sistema (headerBlurEffect do
// react-native-screens — é nativo do RNS, NÃO depende do expo-blur, então
// funciona em qualquer binário). O conteúdo rola POR BAIXO do header.
// Android: header sólido (Material não usa vidro + blur custa GPU).
export const USE_BLUR_HEADER = Platform.OS === 'ios';

// Altura do header nativo p/ telas com header transparente (iOS blur). Usamos
// padding no contentContainer (e não contentInsetAdjustmentBehavior) porque
// ScrollView.scrollTo do RN clampa em -contentInset.top (ignora o inset
// ajustado) → scrollTo({y:0}) deixaria o topo escondido sob o header.
// Retorna 0 quando o blur não está ativo (Android/web) ou fora de um stack.
export function useBlurHeaderInset(enabled = true) {
  const h = React.useContext(HeaderHeightContext);
  if (!enabled || !USE_BLUR_HEADER) return 0;
  return typeof h === 'number' && h > 0 ? h : 0;
}

// Opções comuns de header nativo, preto&branco (tint = cor do texto, sem azul).
// - headerBackButtonDisplayMode 'minimal': só o chevron (a tela anterior,
//   /chat, não tem título → senão apareceria "Voltar"/"chat").
// - search: SearchBarProps do RNS (UISearchController / SearchView Material).
export function nativeHeaderOptions({
  colors = {},
  title = '',
  headerRight,
  headerLeft,
  search,
  largeTitle = false,
  blur = false, // [2026-10-07 native-ui-build] iOS: header translúcido c/ blur do sistema
  isDark,
  ...rest
} = {}) {
  const bg = colors.headerBgSolid || colors.surface || colors.background;
  const fg = colors.text;
  const opts = {
    headerShown: true,
    title: title || '',
    headerTintColor: fg,
    headerTitleStyle: { color: fg },
    headerStyle: bg ? { backgroundColor: bg } : undefined,
    headerShadowVisible: true,
    headerBackButtonDisplayMode: 'minimal',
    headerTitleAlign: Platform.OS === 'ios' ? 'center' : 'left',
    ...(colors.background ? { contentStyle: { backgroundColor: colors.background } } : {}),
  };
  if (largeTitle && Platform.OS === 'ios') {
    opts.headerLargeTitle = true;
    opts.headerLargeTitleShadowVisible = false;
    opts.headerLargeStyle = bg ? { backgroundColor: bg } : undefined;
    opts.headerLargeTitleStyle = { color: fg };
  }
  if (blur && USE_BLUR_HEADER) {
    opts.headerTransparent = true;
    opts.headerBlurEffect = (isDark ?? colors.isDark)
      ? 'systemChromeMaterialDark'
      : (isDark === false ? 'systemChromeMaterialLight' : 'systemChromeMaterial');
    opts.headerStyle = { backgroundColor: 'transparent' };
    if (opts.headerLargeTitle) opts.headerLargeStyle = { backgroundColor: 'transparent' };
  }
  if (headerRight) opts.headerRight = headerRight;
  if (headerLeft) { opts.headerLeft = headerLeft; opts.headerBackVisible = false; }
  if (search) {
    opts.headerSearchBarOptions = {
      hideWhenScrolling: false,
      autoCapitalize: 'none',
      ...(Platform.OS === 'ios' ? { placement: 'stacked' } : {}),
      textColor: fg,
      tintColor: fg,
      headerIconColor: fg,
      hintTextColor: colors.textTertiary || colors.textSecondary,
      ...search,
    };
  }
  return { ...opts, ...rest };
}

// Botão de ícone p/ headerLeft/headerRight: ripple borderless no Android,
// opacidade no iOS, haptic leve, hitSlop generoso (44pt).
export function HeaderIconButton({ onPress, children, accessibilityLabel, disabled, style, testID }) {
  return (
    <Pressable
      onPress={(e) => { try { haptic.light?.(); } catch {} onPress && onPress(e); }}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      android_ripple={{ borderless: true, radius: 22 }}
      style={({ pressed }) => [{
        width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : (pressed && Platform.OS === 'ios' ? 0.5 : 1),
      }, style]}
    >
      {children}
    </Pressable>
  );
}

// Back custom (p/ quando a tela tem sub-navegação interna, ex. categorias do
// /settings): chevron iOS 28pt / seta Material 24dp, como o back do sistema.
export function HeaderBackButton({ onPress, color, accessibilityLabel = 'Voltar' }) {
  return (
    <HeaderIconButton onPress={onPress} accessibilityLabel={accessibilityLabel} style={Platform.OS === 'ios' ? { marginLeft: -8 } : null}>
      {Platform.OS === 'ios'
        ? <IconChevronLeft size={28} color={color} />
        : <IconArrowLeft size={24} color={color} />}
    </HeaderIconButton>
  );
}
